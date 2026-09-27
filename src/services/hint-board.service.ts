import mongoose from "mongoose";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import "../models/user.model"; // registers the User model for populate
import { parseRdAnswer } from "./rd-answer";

type Id = mongoose.Types.ObjectId | string;

export class HintBoardError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const populateUsers = [
  { path: "claimedBy", select: "name" },
  { path: "checkedBy", select: "name" },
  { path: "notes.user", select: "name" },
];

async function findCellOr404(articleId: number, area: string) {
  const cell = await HintCell.findOne({ articleId, area }).populate(populateUsers);
  if (!cell) throw new HintBoardError(404, "Hintvak niet gevonden");
  return cell;
}

async function updateCell(articleId: number, area: string, update: mongoose.UpdateQuery<unknown>) {
  const cell = await HintCell.findOneAndUpdate({ articleId, area }, update, { returnDocument: "after" }).populate(populateUsers);
  if (!cell) throw new HintBoardError(404, "Hintvak niet gevonden");
  return cell;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

export async function getBoard() {
  const articles = await Article.find({ type: "hint" }, { _id: 0, id: 1, title: 1, publishAt: 1, content: 1 })
    .sort({ publishAt: -1 })
    .lean();
  const cells = await HintCell.find().populate(populateUsers).lean();
  return { articles, cells };
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
  if (cell) return cell;

  const existing = await findCellOr404(articleId, area);
  const message =
    existing.status === HintCellStatus.Solving
      ? "Dit vak is al geclaimd"
      : `Dit vak is ${existing.status === HintCellStatus.Solved ? "al opgelost" : "gemarkeerd als geen hint"}`;
  throw new HintBoardError(409, message, { claimedBy: existing.claimedBy ?? null });
}

export async function releaseCell(articleId: number, area: string, user: { _id: Id; admin: boolean }) {
  const filter: Record<string, unknown> = { articleId, area, status: HintCellStatus.Solving };
  if (!user.admin) filter.claimedBy = user._id;

  const cell = await HintCell.findOneAndUpdate(
    filter,
    { $set: { status: HintCellStatus.Open }, $unset: { claimedBy: 1, claimedAt: 1 } },
    { returnDocument: "after" },
  ).populate(populateUsers);
  if (cell) return cell;

  await findCellOr404(articleId, area);
  throw new HintBoardError(409, "Dit vak is niet door jou geclaimd");
}

export async function solveCell(articleId: number, area: string, userId: Id, answer: string, replaceMarker = false) {
  const cell = await findCellOr404(articleId, area);
  const trimmedAnswer = answer.trim();
  const rd = parseRdAnswer(trimmedAnswer);
  let markerId: mongoose.Types.ObjectId | undefined;

  if (rd) {
    const location = { type: "Point" as const, coordinates: [rd.lng, rd.lat] };
    const existing = await Marker.findOne({ type: MarkerType.Hint, area, time: cell.slotTime });

    if (existing && cell.markerId && String(existing._id) === String(cell.markerId)) {
      existing.set("location", location);
      await existing.save();
      markerId = existing._id;
    } else {
      if (existing && !replaceMarker) {
        throw new HintBoardError(409, "Er bestaat al een hint-marker voor dit deelgebied op dit uur", {
          existingMarkerId: String(existing._id),
        });
      }
      if (existing) {
        // If the marker being replaced is linked from a different cell, that cell's link
        // would otherwise point at a deleted marker.
        await HintCell.updateMany(
          { markerId: existing._id, _id: { $ne: cell._id } },
          { $unset: { markerId: 1, answerLocation: 1 } },
        );
        await existing.deleteOne();
      }
      try {
        const marker = await Marker.create({ area, time: cell.slotTime, type: MarkerType.Hint, location });
        markerId = marker._id;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existingMarker = await Marker.findOne({ type: MarkerType.Hint, area, time: cell.slotTime });
        throw new HintBoardError(409, "Er bestaat al een hint-marker voor dit deelgebied op dit uur", {
          existingMarkerId: existingMarker ? String(existingMarker._id) : undefined,
        });
      }
    }
  } else if (cell.markerId) {
    // Answer changed from a coordinate to a word: remove the marker we created earlier
    await Marker.findByIdAndDelete(cell.markerId);
  }

  const unset: Record<string, 1> = { checkedBy: 1 };
  if (!markerId) unset.markerId = 1;
  if (!rd) unset.answerLocation = 1;

  return updateCell(articleId, area, {
    $set: {
      answer: trimmedAnswer,
      answerKind: rd ? "rd" : "text",
      status: HintCellStatus.Solved,
      check: HintCheck.Unchecked,
      claimedBy: userId,
      claimedAt: new Date(),
      ...(markerId ? { markerId } : {}),
      ...(rd ? { answerLocation: [rd.lng, rd.lat] } : {}),
    },
    $unset: unset,
  });
}

export async function setCheck(articleId: number, area: string, userId: Id, check: HintCheck) {
  if (check === HintCheck.Unchecked) {
    return updateCell(articleId, area, { $set: { check }, $unset: { checkedBy: 1 } });
  }
  return updateCell(articleId, area, { $set: { check, checkedBy: userId } });
}

export async function addNote(articleId: number, area: string, userId: Id, text: string) {
  return updateCell(articleId, area, { $push: { notes: { user: userId, text, createdAt: new Date() } } });
}

export async function setStatus(articleId: number, area: string, status: HintCellStatus.Open | HintCellStatus.None) {
  return updateCell(articleId, area, { $set: { status }, $unset: { claimedBy: 1, claimedAt: 1 } });
}
