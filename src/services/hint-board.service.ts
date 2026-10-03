import mongoose from "mongoose";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model"; // also registers the User model for populate
import { parseRdAnswer } from "./rd-answer";
import { isDuplicateKeyError } from "../utils/mongo";
import { ServiceError } from "../http/service-error";
import { currentGeneration } from "../demo/demo-mode";

type Id = mongoose.Types.ObjectId | string;

const populateUsers = [
  { path: "claimedBy", select: "name" },
  { path: "checkedBy", select: "name" },
  { path: "notes.user", select: "name" },
];

async function findCellOr404(articleId: number, area: string) {
  const cell = await HintCell.findOne({ articleId, area }).populate(populateUsers);
  if (!cell) throw new ServiceError(404, "Hintvak niet gevonden");
  return cell;
}

async function updateCell(articleId: number, area: string, update: mongoose.UpdateQuery<unknown>) {
  const cell = await HintCell.findOneAndUpdate({ articleId, area }, update, { returnDocument: "after" }).populate(populateUsers);
  if (!cell) throw new ServiceError(404, "Hintvak niet gevonden");
  return cell;
}

/** How long a built board is shared between requests (every hunter polls it every 3 s). */
const BOARD_CACHE_MS = 1_500;
/** Attempts of a compare-and-set before giving up with a 409 (only under heavy contention on one cell). */
const MAX_ATTEMPTS = 5;

let boardVersion = 0;
let boardCache: { version: number; generation: number; builtAt: number; json: Promise<string> } | null = null;

/** Call after every write to hint cells (or hint articles) so the next board request rebuilds. */
export function invalidateBoardCache() {
  boardVersion++;
  boardCache = null;
}

type UserRef = { _id: mongoose.Types.ObjectId; name: string } | null;

/**
 * The same shape as populate(populateUsers) on lean cells, with one user query instead of one per path.
 */
async function populateBoardUsers<T extends { claimedBy?: unknown; checkedBy?: unknown; notes?: { user?: unknown }[] }>(cells: T[]) {
  const ids = new Set<string>();
  for (const cell of cells) {
    if (cell.claimedBy) ids.add(String(cell.claimedBy));
    if (cell.checkedBy) ids.add(String(cell.checkedBy));
    for (const note of cell.notes ?? []) if (note.user) ids.add(String(note.user));
  }
  const users = ids.size > 0 ? await User.find({ _id: { $in: [...ids] } }, { name: 1 }).lean() : [];
  const byId = new Map(users.map((user) => [String(user._id), { _id: user._id, name: user.name } as UserRef]));
  const lookup = (id: unknown): UserRef => byId.get(String(id)) ?? null;
  for (const cell of cells) {
    if (cell.claimedBy) cell.claimedBy = lookup(cell.claimedBy);
    if (cell.checkedBy) cell.checkedBy = lookup(cell.checkedBy);
    for (const note of cell.notes ?? []) if (note.user) note.user = lookup(note.user);
  }
  return cells;
}

export async function getBoard() {
  const [articles, cells] = await Promise.all([
    Article.find({ type: "hint" }, { _id: 0, id: 1, title: 1, publishAt: 1, content: 1 }).sort({ publishAt: -1 }).lean(),
    HintCell.find().lean(),
  ]);
  return { articles, cells: await populateBoardUsers(cells) };
}

/**
 * The board as JSON, built at most once per ~1.5 s for all users (and rebuilt right after any hint write or a
 * database switch). Concurrent requests share one build.
 */
export function getBoardJson(): Promise<string> {
  const generation = currentGeneration();
  const cached = boardCache;
  if (cached && cached.version === boardVersion && cached.generation === generation && Date.now() - cached.builtAt < BOARD_CACHE_MS) {
    return cached.json;
  }
  const version = boardVersion;
  const json = getBoard().then((board) => JSON.stringify(board));
  const entry = { version, generation, builtAt: Date.now(), json };
  boardCache = entry;
  // A failed build is not shared
  json.catch(() => {
    if (boardCache === entry) boardCache = null;
  });
  return json;
}

export async function claimCell(articleId: number, area: string, userId: Id) {
  const cell = await HintCell.findOneAndUpdate(
    {
      articleId,
      area,
      $or: [{ status: HintCellStatus.Open }, { status: HintCellStatus.Solving, claimedBy: userId }],
    },
    { $set: { status: HintCellStatus.Solving, claimedBy: userId, claimedAt: new Date() } },
    { returnDocument: "after" },
  ).populate(populateUsers);
  if (cell) {
    invalidateBoardCache();
    return cell;
  }

  const existing = await findCellOr404(articleId, area);
  const message =
    existing.status === HintCellStatus.Solving
      ? "Dit vak is al geclaimd"
      : `Dit vak is ${existing.status === HintCellStatus.Solved ? "al opgelost" : "gemarkeerd als geen hint"}`;
  throw new ServiceError(409, message, { claimedBy: existing.claimedBy ?? null });
}

export async function releaseCell(articleId: number, area: string, user: { _id: Id; admin: boolean }) {
  const filter: Record<string, unknown> = { articleId, area, status: HintCellStatus.Solving };
  if (!user.admin) filter.claimedBy = user._id;

  const cell = await HintCell.findOneAndUpdate(
    filter,
    { $set: { status: HintCellStatus.Open }, $unset: { claimedBy: 1, claimedAt: 1 } },
    { returnDocument: "after" },
  ).populate(populateUsers);
  if (cell) {
    invalidateBoardCache();
    return cell;
  }

  await findCellOr404(articleId, area);
  throw new ServiceError(409, "Dit vak is niet door jou geclaimd");
}

function readCell(filter: Record<string, unknown>) {
  return HintCell.findOne(filter).lean();
}

const busyError = () => new ServiceError(409, "Dit vak werd tegelijk door iemand anders aangepast; probeer het opnieuw");

/** Delete a hint marker the board created, unless a cell (still or again) links to it. */
async function deleteMarkerIfUnlinked(markerId: mongoose.Types.ObjectId) {
  if (await HintCell.exists({ markerId })) return;
  await Marker.deleteOne({ _id: markerId, type: MarkerType.Hint });
}

const sameLocation = (a?: number[] | null, b?: number[] | null) => !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Make the hint marker match the cell's current (stored) answer: move the linked marker, or create/adopt the marker
 * of the cell's area and hour and link it. Runs until marker and cell agree, so concurrent solves converge on the
 * answer that won; a marker this call created is removed again when the cell no longer has a coordinate answer.
 */
async function syncHintMarker(cellId: mongoose.Types.ObjectId) {
  let createdMarkerId: mongoose.Types.ObjectId | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cell = await readCell({ _id: cellId });
    if (!cell || cell.status !== HintCellStatus.Solved || cell.answerKind !== "rd" || !cell.answerLocation?.length) {
      // A later answer (text, none) won; whoever wrote it removes the marker it had linked, this one removes its own
      if (createdMarkerId) await deleteMarkerIfUnlinked(createdMarkerId);
      return;
    }
    const location = { type: "Point" as const, coordinates: cell.answerLocation };

    let marker = cell.markerId
      ? await Marker.findOneAndUpdate({ _id: cell.markerId }, { $set: { location } }, { returnDocument: "after" }).lean()
      : null;
    if (!marker) {
      marker = await Marker.findOneAndUpdate(
        { type: MarkerType.Hint, area: cell.area, time: cell.slotTime },
        { $set: { location } },
        { returnDocument: "after" },
      ).lean();
    }
    if (!marker) {
      try {
        const created = await Marker.create({ area: cell.area, time: cell.slotTime, type: MarkerType.Hint, location });
        marker = created.toObject();
        createdMarkerId = created._id;
      } catch (error) {
        if (isDuplicateKeyError(error)) continue; // a concurrent solve created it; the next attempt adopts it
        throw error;
      }
    }
    if (String(cell.markerId) !== String(marker._id)) {
      const linked = await HintCell.updateOne(
        { _id: cell._id, markerId: cell.markerId ?? null, answerKind: "rd", answerLocation: cell.answerLocation },
        { $set: { markerId: marker._id } },
      );
      if (linked.matchedCount === 0) continue;
    }

    // Done when nothing changed meanwhile; otherwise go again with the newer answer
    const after = await HintCell.findById(cellId, { answerKind: 1, answerLocation: 1, markerId: 1, status: 1 }).lean();
    const markerNow = await Marker.findById(marker._id, { location: 1 }).lean();
    if (
      after?.status === HintCellStatus.Solved &&
      after.answerKind === "rd" &&
      String(after.markerId) === String(marker._id) &&
      sameLocation(after.answerLocation, cell.answerLocation) &&
      sameLocation(markerNow?.location?.coordinates, cell.answerLocation)
    ) {
      return;
    }
  }
  // Gave up under contention: the writers still running finish the job, but don't leave our own marker behind
  const cell = await readCell({ _id: cellId });
  if (createdMarkerId && String(cell?.markerId) !== String(createdMarkerId) && cell?.answerKind !== "rd") {
    await deleteMarkerIfUnlinked(createdMarkerId);
  }
}

/**
 * Store an answer. A coordinate (RD) answer places the hint marker of the area and hour (409 with existingMarkerId
 * when another hint marker is already there, unless replaceMarker); a word removes the marker the cell had. The
 * cell is updated first (compare-and-set on its marker link), then the marker follows the answer that won.
 */
export async function solveCell(articleId: number, area: string, userId: Id, answer: string, replaceMarker = false) {
  const trimmedAnswer = answer.trim();
  const rd = parseRdAnswer(trimmedAnswer);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cell = await readCell({ articleId, area });
    if (!cell) throw new ServiceError(404, "Hintvak niet gevonden");

    if (rd) {
      const existing = await Marker.findOne({ type: MarkerType.Hint, area, time: cell.slotTime }, { _id: 1 }).lean();
      if (existing && String(existing._id) !== String(cell.markerId)) {
        if (!replaceMarker) {
          throw new ServiceError(409, "Er bestaat al een hint-marker voor dit deelgebied op dit uur", {
            existingMarkerId: String(existing._id),
          });
        }
        // If the marker being replaced is linked from a different cell, that cell's link
        // would otherwise point at a deleted marker.
        await HintCell.updateMany({ markerId: existing._id, _id: { $ne: cell._id } }, { $unset: { markerId: 1, answerLocation: 1 } });
        await Marker.deleteOne({ _id: existing._id });
      }
    }

    const unset: Record<string, 1> = { checkedBy: 1 };
    if (!rd) Object.assign(unset, { markerId: 1, answerLocation: 1 });
    const updated = await HintCell.updateOne(
      { _id: cell._id, markerId: cell.markerId ?? null },
      {
        $set: {
          answer: trimmedAnswer,
          answerKind: rd ? "rd" : "text",
          status: HintCellStatus.Solved,
          check: HintCheck.Unchecked,
          claimedBy: userId,
          claimedAt: new Date(),
          ...(rd ? { answerLocation: [rd.lng, rd.lat] } : {}),
        },
        $unset: unset,
      },
    );
    if (updated.matchedCount === 0) continue; // the marker link changed meanwhile: decide again

    // Answer changed from a coordinate to a word: remove the marker we created earlier
    if (!rd && cell.markerId) await deleteMarkerIfUnlinked(cell.markerId);
    if (rd) await syncHintMarker(cell._id);
    invalidateBoardCache();
    return findCellOr404(articleId, area);
  }
  throw busyError();
}

export async function setCheck(articleId: number, area: string, userId: Id, check: HintCheck) {
  const cell =
    check === HintCheck.Unchecked
      ? await updateCell(articleId, area, { $set: { check }, $unset: { checkedBy: 1 } })
      : await updateCell(articleId, area, { $set: { check, checkedBy: userId } });
  invalidateBoardCache();
  return cell;
}

export async function addNote(articleId: number, area: string, userId: Id, text: string) {
  const cell = await updateCell(articleId, area, { $push: { notes: { user: userId, text, createdAt: new Date() } } });
  invalidateBoardCache();
  return cell;
}

/**
 * Mark a cell as "no hint" or open it again. Clears the claim and any answer (and the hint marker the answer placed).
 * Only the claimer may do this to a cell being solved, and a solved cell is left alone; admins may always.
 */
export async function setStatus(
  articleId: number,
  area: string,
  status: HintCellStatus.Open | HintCellStatus.None,
  user: { _id: Id; admin: boolean },
) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cell = await readCell({ articleId, area });
    if (!cell) throw new ServiceError(404, "Hintvak niet gevonden");
    if (!user.admin) {
      if (cell.status === HintCellStatus.Solving && cell.claimedBy && String(cell.claimedBy) !== String(user._id)) {
        const claimed = await findCellOr404(articleId, area);
        throw new ServiceError(409, "Dit vak is niet door jou geclaimd", { claimedBy: claimed.claimedBy ?? null });
      }
      if (cell.status === HintCellStatus.Solved) throw new ServiceError(409, "Dit vak is al opgelost");
    }

    // Compare-and-set on what the checks above saw
    const updated = await HintCell.updateOne(
      {
        _id: cell._id,
        status: cell.status,
        claimedBy: cell.claimedBy ?? null,
        answer: cell.answer ?? null,
        markerId: cell.markerId ?? null,
      },
      {
        $set: { status, check: HintCheck.Unchecked },
        $unset: { claimedBy: 1, claimedAt: 1, answer: 1, answerKind: 1, answerLocation: 1, markerId: 1, checkedBy: 1 },
      },
    );
    if (updated.matchedCount === 0) continue;

    if (cell.markerId) await deleteMarkerIfUnlinked(cell.markerId);
    invalidateBoardCache();
    return findCellOr404(articleId, area);
  }
  throw busyError();
}
