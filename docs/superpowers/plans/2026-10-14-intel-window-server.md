# Intel window — server cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the server down to what the new intel window uses: answer-only hint cells, assignments without the overwrite guard, no presence, summaries without "voor ons" points.

**Architecture:** Pure removal/simplification in the Express + Mongoose server. `GET /hints/board`, `GET /hints/parse-answer`, `POST /hints/:articleId/:area/solve`, `/assignments*`, `/articles/read`, `POST /articles/:id/read` and the summaries cron stay. Legacy fields already stored on hint cells (`claimedBy`, `claimedAt`, `check`, `checkedBy`, `notes`, status `solving`) are hidden from the board and cleaned up on the next solve, so no migration is needed.

**Tech Stack:** Bun test runner, TypeScript, Express, express-validator, Mongoose (MongoDB in docker `jotihunt-mongodb-1`, tests use DB `jotihunt-test`).

Spec: client repo `docs/superpowers/specs/2026-10-14-intel-window-design.md`.

## Global Constraints

- Run tests with `npx --yes bun test <path>` and types with `npx --yes bun x tsc --noEmit` (bun is not on PATH).
- Never `pkill -f`; never restart the docker stack.
- Work on branch `feat/intel-window` from `main` in `jotihunt-tracker-server`.
- The Android app reads `claimedBy`, `checkedBy`, `notes`, `check` as optional with defaults (`HintDto.kt`): removing them from the board is safe. Do not rename or remove `status`, `answer`, `answerKind`, `answerLocation`, `markerId`, `snippet`, `articleChanged`, `slotTime`, `publishAt`, `articleId`, `area`, `_id`.
- Assignment status values stay `open | busy | submitted | skipped`.
- Dutch user-facing error messages, as today.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 0: Branch

- [ ] **Step 1:** `cd jotihunt-tracker-server && git checkout -b feat/intel-window main`
- [ ] **Step 2:** `npx --yes bun test` — note the baseline pass count (all green expected).

---

### Task 1: Hint cells are answer-only

**Files:**
- Modify: `src/models/hint-cell.model.ts`
- Modify: `src/services/hint-board.service.ts`
- Modify: `src/controllers/hints.controller.ts`
- Modify: `src/routes/hints.route.ts`
- Modify: `src/services/hint-board.service.test.ts`
- Modify: `src/demo/generator/plans.ts`, `src/demo/generator/plans.test.ts`, `src/demo/generator/generate-world.ts`, `src/demo/generator/generate-world.test.ts`, `src/demo/generator/constants.ts` (only if `HINT_NOTES` ends up unused)

**Interfaces:**
- Produces: `solveCell(articleId: number, area: string, answer: string, replaceMarker = false)` (no user id, no overwrite). `getBoard()` returns `{ articles, cells }` with cells lacking `claimedBy`, `claimedAt`, `check`, `checkedBy`, `notes`, and no cell with status `solving` (shown as `open`). `HintCellStatus` = `Open | Solved | None`. `HintCheck` no longer exists. `NoteSchema` stays exported from `hint-cell.model.ts` (assignments use it).
- HTTP: `POST /hints/:articleId/:area/solve` body `{ answer: string, replaceMarker?: boolean }`. The routes `claim`, `release`, `check`, `notes`, `status` are gone (404 from Express).

- [ ] **Step 1: Rewrite the service tests first**

In `src/services/hint-board.service.test.ts`:
- Import line becomes:
  ```ts
  import { HintCell, HintCellStatus } from "../models/hint-cell.model";
  import { getBoard, getBoardJson, invalidateBoardCache, solveCell } from "./hint-board.service";
  ```
  (drop `HintCheck`; keep the `User` import only if still used — `makeUser` can go when nothing calls it).
- Delete the `describe` blocks `claimCell`, `releaseCell`, `overwrite guard`, `setCheck, addNote, setStatus` entirely, and inside `solveCell` delete the tests `"solving resets the check"` and `"with overwrite anyone may answer a cell claimed by someone else"`.
- Every remaining `solveCell(1, "x", <user>._id, answer, replaceMarker?, overwrite?)` call drops the user argument and the overwrite argument: `solveCell(1, "alpha", "2126 4692")`, `solveCell(1, "alpha", "2126 4692", true)`, and in the concurrency tests `solveCell(1, "alpha", "2126 4692")` (was `…, false, true`).
- Replace the `getBoard` and `getBoard JSON` blocks with:

```ts
describe("getBoard", () => {
  test("returns hint articles newest first and the cells without claim, check or notes fields", async () => {
    await Article.create([
      { id: 1, title: "Hint 1", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" },
      { id: 2, title: "Hint 2", type: "hint", publishAt: new Date("2026-10-17T13:00:00Z"), content: "b" },
      { id: 3, title: "Nieuws", type: "news", publishAt: new Date("2026-10-17T14:00:00Z"), content: "c" },
    ]);
    await makeCell();
    await solveCell(1, "alpha", "2126 4692");
    const board = await getBoard();
    expect(board.articles.map((article) => article.id)).toEqual([2, 1]);
    expect(board.cells[0]).toMatchObject({ area: "alpha", status: HintCellStatus.Solved, answer: "2126 4692" });
    for (const field of ["claimedBy", "claimedAt", "check", "checkedBy", "notes"]) expect(board.cells[0]).not.toHaveProperty(field);
  });

  test("a legacy cell (claimed, checked, with notes, status solving) shows as open without those fields", async () => {
    const cell = await makeCell();
    await HintCell.collection.updateOne(
      { _id: cell._id },
      { $set: { status: "solving", claimedBy: cell._id, claimedAt: new Date(), check: "verified", checkedBy: cell._id, notes: [{ text: "oud" }] } },
    );
    const [shown] = (await getBoard()).cells;
    expect(shown.status).toBe(HintCellStatus.Open);
    for (const field of ["claimedBy", "claimedAt", "check", "checkedBy", "notes"]) expect(shown).not.toHaveProperty(field);
  });
});

describe("getBoard JSON", () => {
  test("is the board as JSON", async () => {
    await Promise.all([makeCell("alpha"), makeCell("bravo")]);
    await Article.create({ id: 1, title: "Hint 1", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" });
    await solveCell(1, "bravo", "2126 4692");
    invalidateBoardCache();
    expect(await getBoardJson()).toBe(JSON.stringify(await getBoard()));
  });

  test("is shared for a moment, rebuilt after a write or a database switch", async () => {
    await makeCell();
    invalidateBoardCache();
    const first = await getBoardJson();
    // A write that bypasses the service is not seen while cached
    await HintCell.updateOne({ area: "alpha" }, { $set: { snippet: "stil" } });
    expect(await getBoardJson()).toBe(first);
    nextGeneration();
    const afterSwitch = await getBoardJson();
    expect(afterSwitch).toContain("stil");
    await solveCell(1, "alpha", "doedelzak");
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.Solved);
  });

  test("concurrent requests share one build", async () => {
    await makeCell();
    invalidateBoardCache();
    const [x, y] = [getBoardJson(), getBoardJson()];
    expect(x).toBe(y);
    await x;
  });
});
```

- Add to the `solveCell` block:

```ts
  test("anyone may answer again: the last answer wins and the legacy claim/check fields are cleared", async () => {
    const cell = await makeCell();
    await HintCell.collection.updateOne({ _id: cell._id }, { $set: { claimedBy: cell._id, check: "disputed", notes: [{ text: "oud" }] } });
    await solveCell(1, "alpha", "doedelzak");
    const again = await solveCell(1, "alpha", "haggis");
    expect(again.answer).toBe("haggis");
    const raw = await HintCell.collection.findOne({ _id: cell._id });
    for (const field of ["claimedBy", "claimedAt", "check", "checkedBy", "notes"]) expect(raw).not.toHaveProperty(field);
  });

  test("a 'none' cell can still be answered", async () => {
    await makeCell("alpha", HintCellStatus.None);
    expect((await solveCell(1, "alpha", "doedelzak")).status).toBe(HintCellStatus.Solved);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx --yes bun test src/services/hint-board.service.test.ts`
Expected: FAIL (type/arity errors: `solveCell` still takes a user id, legacy fields still on the board).

- [ ] **Step 3: Model**

`src/models/hint-cell.model.ts` becomes:

```ts
import mongoose from "mongoose";

export enum HintCellStatus {
  Open = "open",
  Solved = "solved",
  None = "none",
}

/** A team note with its author (assignments) */
export const NoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

/**
 * One hint article × one area. Older documents may still hold claimedBy/claimedAt/check/checkedBy/notes and status
 * "solving" from the old hints page: the board hides them and the next solve removes them.
 */
const HintCellSchema = new mongoose.Schema({
  articleId: { type: Number, required: true },
  area: { type: String, required: true, lowercase: true },
  publishAt: { type: Date, required: true },
  slotTime: { type: Date, required: true },
  snippet: { type: String },
  status: { type: String, enum: Object.values(HintCellStatus), default: HintCellStatus.Open, required: true },
  answer: { type: String },
  answerKind: { type: String, enum: ["rd", "text"] },
  answerLocation: { type: [Number], default: undefined }, // [lng, lat] for RD answers
  markerId: { type: mongoose.Schema.Types.ObjectId, ref: "Marker" },
  articleChanged: { type: Boolean, default: false, required: true },
});

HintCellSchema.index({ articleId: 1, area: 1 }, { unique: true });

export const HintCell = mongoose.model("HintCell", HintCellSchema);
```

- [ ] **Step 4: Service**

In `src/services/hint-board.service.ts`:
- Imports: drop `HintCheck`, `User`, `conflictError`/`setByOther`. Keep `mongoose`, `Article`, `HintCell`, `HintCellStatus`, `Marker`, `MarkerType`, `parseRdAnswer`, `isDuplicateKeyError`, `ServiceError`, `currentGeneration`.
- Delete `populateUsers`, `updateCell`, `UserRef`, `populateBoardUsers`, `claimCell`, `releaseCell`, `setCheck`, `addNote`, `setStatus`.
- Add, above `findCellOr404`:

```ts
/** Fields of the old hints page that may still be stored on a cell; never sent, removed on the next solve */
const LEGACY_FIELDS = ["claimedBy", "claimedAt", "check", "checkedBy", "notes"] as const;
const HIDE_LEGACY = Object.fromEntries(LEGACY_FIELDS.map((field) => [field, 0])) as Record<(typeof LEGACY_FIELDS)[number], 0>;
const UNSET_LEGACY = Object.fromEntries(LEGACY_FIELDS.map((field) => [field, 1])) as Record<(typeof LEGACY_FIELDS)[number], 1>;

/** A cell as sent to clients: a legacy "solving" cell counts as open */
function shown<T extends { status: string }>(cell: T): T {
  return cell.status === "solving" ? { ...cell, status: HintCellStatus.Open } : cell;
}
```

- `findCellOr404` becomes:

```ts
async function findCellOr404(articleId: number, area: string) {
  const cell = await HintCell.findOne({ articleId, area }, HIDE_LEGACY).lean();
  if (!cell) throw new ServiceError(404, "Hintvak niet gevonden");
  return shown(cell);
}
```

- `getBoard` becomes:

```ts
export async function getBoard() {
  const [articles, cells] = await Promise.all([
    Article.find({ type: "hint" }, { _id: 0, id: 1, title: 1, publishAt: 1, content: 1 }).sort({ publishAt: -1 }).lean(),
    HintCell.find({}, HIDE_LEGACY).lean(),
  ]);
  return { articles, cells: cells.map(shown) };
}
```

- `solveCell` becomes (marker logic unchanged, guard and claim bookkeeping gone):

```ts
/**
 * Store an answer; anyone may answer, the last answer wins. A coordinate (RD) answer places the hint marker of the
 * area and hour (409 with existingMarkerId when another hint marker is already there, unless replaceMarker); a word
 * removes the marker the cell had. The cell is updated with a compare-and-set on its marker link, then the marker
 * follows the answer that won.
 */
export async function solveCell(articleId: number, area: string, answer: string, replaceMarker = false) {
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

    const unset: Record<string, 1> = { ...UNSET_LEGACY };
    if (!rd) Object.assign(unset, { markerId: 1, answerLocation: 1 });
    const updated = await HintCell.updateOne(
      { _id: cell._id, markerId: cell.markerId ?? null },
      {
        $set: {
          answer: trimmedAnswer,
          answerKind: rd ? "rd" : "text",
          status: HintCellStatus.Solved,
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
```

- [ ] **Step 5: Controller and route**

`src/controllers/hints.controller.ts`: delete `claim`, `release`, `check`, `addNote`, `setStatus`; `solve` becomes:

```ts
export function solve(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  const { answer, replaceMarker } = req.body;
  return respond(res, 200, () => board.solveCell(articleId, area, answer, replaceMarker === true));
}
```

`src/routes/hints.route.ts` becomes:

```ts
import express from "express";
import { body, param, query } from "express-validator";
import * as hintsController from "../controllers/hints.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { DEFAULT_AREAS } from "../services/hint-parser";

const cellParams = [param("articleId").isInt({ min: 0 }), param("area").isIn(DEFAULT_AREAS)];

const router = express.Router();

router.get("/board", verifyToken, hintsController.getBoard);
router.get(
  "/parse-answer",
  [verifyToken, validate([query("answer").optional().isString().isLength({ max: 200 })])],
  hintsController.parseAnswer,
);
router.post(
  "/:articleId/:area/solve",
  [
    verifyToken,
    limitUserWrites(60),
    validate([
      ...cellParams,
      body("answer").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Antwoord is verplicht."),
      body("replaceMarker").optional().isBoolean(),
    ]),
  ],
  hintsController.solve,
);

export default router;
```

- [ ] **Step 6: Demo generator — no claims, checks or notes**

`src/demo/generator/plans.ts`:
- Remove `HintCheck` from the imports, remove `HINT_NOTES` from the `./constants` import, delete `NotePlan`, `otherUser`, and `claimedBy`, `claimedAt`, `check`, `checkedBy`, `notes` from `CellPlan`. Remove `userCount` from `planHintCells`' input type.
- `CellPlan` becomes `{ articleId: number; area: string; status: HintCellStatus }`.
- Replace the doc comment and body of `planHintCells` with:

```ts
/**
 * Plan the state of every hint cell:
 * - old hints: solved;
 * - the hint before the newest: about 60% solved, the rest open;
 * - the newest hint: open; red areas "none".
 * A hint titled "Hint <area>" only concerns that area (the others become "none"); cells the article marks "-" stay "none".
 */
export function planHintCells(input: { hints: HintInput[]; cells: CellInput[]; redAreas: string[]; now: Date; rng: Rng }): CellPlan[] {
  const { rng } = input;
  const red = new Set(input.redAreas.map((area) => area.toLowerCase()));
  const byNewest = [...input.hints].sort((a, b) => b.slotTime.getTime() - a.slotTime.getTime());
  const plans: CellPlan[] = [];

  byNewest.forEach((hint, rank) => {
    const phase = hintPhase(rank);
    const titled = /^hint\s+(\w+)$/i.exec(hint.title.trim())?.[1]?.toLowerCase();
    const onlyArea = DEMO_AREAS.some((area) => area.toLowerCase() === titled) ? titled : undefined;
    const cells = input.cells.filter((cell) => cell.articleId === hint.articleId).sort((a, b) => a.area.localeCompare(b.area));
    const hintPlans: CellPlan[] = cells.map((cell) => {
      const none = cell.status === HintCellStatus.None || (onlyArea !== undefined && cell.area !== onlyArea) || (phase === "newest" && red.has(cell.area));
      return { articleId: cell.articleId, area: cell.area, status: none ? HintCellStatus.None : HintCellStatus.Open };
    });
    const active = hintPlans.filter((plan) => plan.status !== HintCellStatus.None);

    if (phase === "old") {
      for (const plan of active) plan.status = HintCellStatus.Solved;
    } else if (phase === "recent") {
      const shuffled = rng.shuffle(active);
      const solvedCount = Math.max(1, Math.round(shuffled.length * 0.6));
      shuffled.slice(0, solvedCount).forEach((plan) => (plan.status = HintCellStatus.Solved));
    }
    plans.push(...hintPlans);
  });
  return plans;
}
```

  If `clampToNow` or `MINUTE_MS` become unused in `plans.ts`, delete them / their import (they may still be used by other planners in the file — check with grep before deleting). If `input.now` is no longer read inside `planHintCells`, keep the field (callers pass it; other planners share the shape) — but `tsc` must stay clean.
- `src/demo/generator/generate-world.ts`: in the call to `planHintCells`, drop `userCount`. In the loop over `plans`, replace the claim/check/notes handling so the update is:

```ts
    const set: Record<string, unknown> = { status: plan.status };
    const unset: Record<string, 1> = { claimedBy: 1, claimedAt: 1, check: 1, checkedBy: 1, notes: 1 };
    const area = areaByLower.get(plan.area);
    if (plan.status === HintCellStatus.Solved && area) {
      const answer = formatRdAnswer(...positionAt(routes.get(area)!, cell.slotTime.getTime()));
      const rd = parseRdAnswer(answer)!;
      const location = { type: "Point" as const, coordinates: [rd.lng, rd.lat] };
      solved.push({ marker: { area: plan.area, time: cell.slotTime, type: MarkerType.Hint, location }, set });
      Object.assign(set, { answer, answerKind: "rd", answerLocation: [rd.lng, rd.lat], markerId: null });
    }
    updates.push({ cellId: cell._id, set, unset });
```

  and remove the `HintCheck` import there.
- `src/demo/generator/constants.ts`: delete `HINT_NOTES` if `grep -rn HINT_NOTES src` shows no other user.
- `src/demo/generator/plans.test.ts`: drop `HintCheck` from the import and `userCount: 8` from both `planHintCells` calls; replace the four state tests with:

```ts
  test("old hints are solved except 'none' cells", () => {
    for (const articleId of [100, 101, 103]) {
      for (const plan of of(articleId)) expect(plan.status).toBe(articleId === 101 && plan.area === "bravo" ? HintCellStatus.None : HintCellStatus.Solved);
    }
  });

  test("'Hint Oscar' only concerns Oscar", () => {
    expect(
      of(102)
        .filter((plan) => plan.status !== HintCellStatus.None)
        .map((plan) => plan.area),
    ).toEqual(["oscar"]);
  });

  test("the hint before the newest mixes solved and open; the newest is open, red areas none", () => {
    const recent = of(104).map((plan) => plan.status);
    expect(recent.filter((status) => status === HintCellStatus.Solved).length).toBeGreaterThan(0);
    expect(recent.filter((status) => status === HintCellStatus.Open).length).toBeGreaterThan(0);
    const newest = of(105);
    expect(newest.filter((plan) => plan.status === HintCellStatus.None).map((plan) => plan.area)).toEqual(["charlie", "golf"]);
    expect(newest.filter((plan) => plan.status === HintCellStatus.Open)).toHaveLength(7);
  });
```

  (keep `"deterministic"`, without `userCount`).
- `src/demo/generator/generate-world.test.ts`: drop `HintCheck` from the import; replace the `Solving` and `Disputed` expectations with:

```ts
    expect(await HintCell.countDocuments({ status: HintCellStatus.Open })).toBeGreaterThan(0);
    expect(await HintCell.countDocuments({ $or: [{ claimedBy: { $exists: true } }, { notes: { $exists: true } }, { check: { $exists: true } }] })).toBe(0);
```

  (the existing `Open` line stays once; don't duplicate it).

- [ ] **Step 7: Run tests and types**

Run: `npx --yes bun test src/services/hint-board.service.test.ts src/demo && npx --yes bun x tsc --noEmit`
Expected: all PASS, tsc no output. Then `grep -rn "claimCell\|releaseCell\|setCheck\|HintCheck\|HintCellStatus.Solving" src` → no hits.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(hints): answer-only hint cells (no claims, checks, notes or status writes)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Assignments without the overwrite guard; drop write-conflict

**Files:**
- Modify: `src/services/assignment.service.ts`, `src/controllers/assignments.controller.ts`, `src/routes/assignments.route.ts`, `src/app.test.ts`
- Delete: `src/services/write-conflict.ts`

**Interfaces:**
- Produces: `setAssignmentStatus(articleId: number, status: AssignmentStatus, userId: Id)`, `setAssignmentOwner(articleId: number, ownerId: string | null, userId: Id)`; both return the populated assignment view (unchanged shape: `owner`, `ownerBy`, `statusBy` populated with `name`). HTTP bodies: `{ status }`, `{ owner: string | null }`, `{ text }`; an `overwrite` key is ignored by validation (not declared).

- [ ] **Step 1: Test** — in `src/app.test.ts`, rename the describe to `"intel: assignments and read state"`, and replace the test `"a status someone else set is a 409 with the conflict; overwrite: true goes through"` with:

```ts
  test("anyone may change a status someone else set; the last write wins and records who", async () => {
    const [a, b] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(7, "assignment");
    expect((await request("/assignments/7/status", { method: "POST", token: tokenFor(a), json: { status: "busy" } })).status).toBe(200);
    const changed = await request("/assignments/7/status", { method: "POST", token: tokenFor(b), json: { status: "skipped" } });
    expect(changed.status).toBe(200);
    expect((await changed.json()) as { status: string; statusBy: { name: string } }).toMatchObject({ status: "skipped", statusBy: { name: "Daan" } });
  });

  test("anyone may take over an owned assignment", async () => {
    const [a, b] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(7, "assignment");
    await request("/assignments/7/owner", { method: "POST", token: tokenFor(a), json: { owner: String(a._id) } });
    const taken = await request("/assignments/7/owner", { method: "POST", token: tokenFor(b), json: { owner: String(b._id) } });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { owner: { name: string } }).owner.name).toBe("Daan");
  });
```

  In `"an assignment write without a body…"`, the line posting `{ overwrite: true }` to owner stays (still a 400: owner missing).

- [ ] **Step 2:** `npx --yes bun test src/app.test.ts` → the two new tests FAIL (409).

- [ ] **Step 3: Service** — in `src/services/assignment.service.ts` drop the `write-conflict` import, `MAX_ATTEMPTS`, `busyError`, `same` and replace the two setters with:

```ts
/** Set how far an assignment is; the last write wins */
export async function setAssignmentStatus(articleId: number, status: AssignmentStatus, userId: Id) {
  await ensureAssignment(articleId);
  await Assignment.updateOne({ articleId }, { $set: { status, statusBy: userId, statusAt: new Date() } });
  return view(articleId);
}

/** Give an assignment to a user, or to nobody with null; the last write wins */
export async function setAssignmentOwner(articleId: number, ownerId: string | null, userId: Id) {
  if (ownerId !== null && !(mongoose.isValidObjectId(ownerId) && (await User.exists({ _id: ownerId })))) {
    throw new ServiceError(400, "Onbekende gebruiker");
  }
  await ensureAssignment(articleId);
  const change = ownerId === null ? { $unset: { owner: 1 }, $set: { ownerBy: userId, ownerAt: new Date() } } : { $set: { owner: ownerId, ownerBy: userId, ownerAt: new Date() } };
  await Assignment.updateOne({ articleId }, change);
  return view(articleId);
}
```

- [ ] **Step 4: Controller** — `setStatus` / `setOwner` stop passing `overwrite`:

```ts
export function setStatus(req: Request, res: Response) {
  return respond(res, 200, () => assignments.setAssignmentStatus(articleId(req), req.body?.status, req.user!._id));
}

export function setOwner(req: Request, res: Response) {
  return respond(res, 200, () => assignments.setAssignmentOwner(articleId(req), req.body?.owner ?? null, req.user!._id));
}
```

- [ ] **Step 5: Route** — in `src/routes/assignments.route.ts` delete the `overwrite` validator const and remove it from the status and owner `validate([...])` arrays.
- [ ] **Step 6:** `git rm src/services/write-conflict.ts`; `grep -rn "write-conflict\|conflictError\|setByOther\|overwrite" src` → no hits outside comments you then remove.
- [ ] **Step 7:** `npx --yes bun test src/app.test.ts && npx --yes bun x tsc --noEmit` → PASS.
- [ ] **Step 8: Commit** `feat(assignments): last write wins (drop the overwrite guard)` + co-author line.

---

### Task 3: Remove presence

**Files:**
- Delete: `src/routes/presence.route.ts`, `src/controllers/presence.controller.ts`, `src/services/presence.service.ts`, `src/services/presence.service.test.ts`
- Modify: `src/app.ts` (lines 24 and 89), `src/app.test.ts`

- [ ] **Step 1:** In `src/app.test.ts` remove `["/presence", { method: "POST", json: { itemId: 5 } }]` from the 401 list and delete the test `"presence: a heartbeat lists the caller…"`. Add to the 401 test after the loop:

```ts
    // The old hints page's presence heartbeat is gone
    expect((await request("/presence", { method: "POST", token: tokenFor(await createUser()), json: { itemId: 5 } })).status).toBe(404);
```

- [ ] **Step 2:** `npx --yes bun test src/app.test.ts` → FAIL (presence still answers).
- [ ] **Step 3:** Remove `import presenceRoute from "./routes/presence.route";` and `app.use("/presence", presenceRoute);` from `src/app.ts`; `git rm` the four files. `grep -rn "presence" src` → no hits (except unrelated words, check each).
- [ ] **Step 4:** `npx --yes bun test src/app.test.ts && npx --yes bun x tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat: remove the hints page presence heartbeat` + co-author line.

---

### Task 4: Summaries without "voor ons" points

**Files:**
- Modify: `src/services/article-summary.service.ts`, `src/services/article-summary.service.test.ts`, `src/models/article.model.ts`, `src/services/article-sync.service.ts`, `src/services/article-sync.service.test.ts`

**Interfaces:**
- Produces: `ArticleSummary = { summary: string }`; `storeSummary(article, { summary })` sets `summary` + `summaryHash` and unsets `summaryPoints`. Articles in the API no longer carry `summaryPoints` once re-summarised; the model no longer declares it.

- [ ] **Step 1: Tests** — in `article-summary.service.test.ts`:
  - mocked model answers become `JSON.stringify({ summary: "…" })` (drop `points`);
  - the first parse test expects `result` toEqual `{ summary: "Om 23:00 wisselen de vossen." }`;
  - delete the test `"keeps at most 4 points and cuts a long summary"` and add:

```ts
  test("cuts a long summary", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "y".repeat(900) }));
    const result = await createArticleSummarizer({ model }).summarize({ title: "t", type: "news", content: "c" });
    expect(result.summary).toHaveLength(600);
  });

  test("the prompt asks for a summary only", () => {
    const prompt = buildSummaryPrompt({ title: "t", type: "news", content: "c" });
    expect(prompt).toContain('"summary"');
    expect(prompt).not.toContain('"points"');
  });
```

  (copy the `summarize({...})` argument style and the mock helper from the neighbouring tests if they differ);
  - invalid answers list becomes `['{"summary":""}', '{}', "not json"]`;
  - `storeSummary` test: `storeSummary({ id: 1, contentHash: "hash-1" }, { summary: "kort" })`, expectation `toMatchObject({ summary: "kort", summaryHash: "hash-1" })` plus `expect((await Article.findOne({ id: 1 }).lean())).not.toHaveProperty("summaryPoints")` after first seeding the article with `summaryPoints: ["oud"]` via `Article.collection.updateOne`;
  - every other `{ summary: "…", points: [...] }` literal loses `points`.
  In `article-sync.service.test.ts` remove `summaryPoints` from the two `$set`s and their expectations (line ~130 `expect(changed.summaryPoints ?? []).toEqual([])` goes; line ~141 `toMatchObject` drops `summaryPoints`).
- [ ] **Step 2:** `npx --yes bun test src/services/article-summary.service.test.ts src/services/article-sync.service.test.ts` → FAIL.
- [ ] **Step 3: Implementation** in `article-summary.service.ts`:

```ts
export interface ArticleSummary {
  summary: string;
}
```

  delete `MAX_POINTS`, `MAX_POINT_CHARS`; schema:

```ts
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
} satisfies JSONSchema7;
```

  prompt: delete the `- "points": …` line (keep the `- "summary": …` line); `cleanSummary`:

```ts
/** The part of the answer we can use; an answer without a summary is invalid */
function cleanSummary(output: unknown): ArticleSummary {
  const raw = (output ?? {}) as { summary?: unknown };
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  if (!summary) throw invalidAnswer();
  return { summary };
}
```

  `storeSummary`'s update becomes `{ $set: { summary: summary.summary, summaryHash: article.contentHash }, $unset: { summaryPoints: 1 } }`.
  `article.model.ts`: delete the `summaryPoints` field and its comment. `article-sync.service.ts:107`: `$unset: { summary: 1, summaryPoints: 1, summaryHash: 1 }` stays as is (clears legacy points too) — no change needed.
- [ ] **Step 4:** `npx --yes bun test src/services && npx --yes bun x tsc --noEmit` → PASS. `grep -rn "summaryPoints\|points" src/services/article-summary.service.ts` → only `maxPoints`.
- [ ] **Step 5: Commit** `feat(summaries): summary text only (drop the "voor ons" points)` + co-author line.

---

### Task 5: "Gelezen door" with names

The window shows who read a news item or opdracht as name chips; the read state only had counts.

**Files:**
- Modify: `src/services/article-read.service.ts`, `src/controllers/articles.controller.ts` (doc comment only), `src/app.test.ts`

**Interfaces:**
- Produces: `GET /articles/read` → `{ read: number[]; readBy: Record<string, string[]> }` — per article id the names of the users who opened it, sorted by name.

- [ ] **Step 1: Test** — in `src/app.test.ts`, the test `"marking an article read shows in the read state; a seeded test article is a 404"`: create the reading user with a name (`createUser({ name: "Sanne" })`, adapt the variable used for its token) and change the expectation to:

```ts
    expect(await res.json()).toEqual({ read: [3], readBy: { "3": ["Sanne"] } });
```

  and add a test:

```ts
  test("read state lists the readers of an article by name, sorted", async () => {
    const [sanne, daan] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(3, "news");
    for (const user of [sanne, daan]) expect((await request("/articles/3/read", { method: "POST", token: tokenFor(user) })).status).toBe(204);
    const state = (await (await request("/articles/read", { token: tokenFor(sanne) })).json()) as { read: number[]; readBy: Record<string, string[]> };
    expect(state).toEqual({ read: [3], readBy: { "3": ["Daan", "Sanne"] } });
  });
```

  (check the status the existing read test expects from `POST /articles/:id/read` — use the same, it may be 200 instead of 204).
- [ ] **Step 2:** `npx --yes bun test src/app.test.ts` → FAIL.
- [ ] **Step 3: Implementation** — replace `getReadState`:

```ts
/** The articles this user read, and per article the names of the users who read it (sorted) */
export async function getReadState(userId: Id): Promise<{ read: number[]; readBy: Record<string, string[]> }> {
  const [user, readers] = await Promise.all([
    User.findById(userId, { readArticles: 1 }).lean(),
    User.find({ "readArticles.0": { $exists: true } }, { name: 1, readArticles: 1 }).sort({ name: 1 }).lean(),
  ]);
  const readBy: Record<string, string[]> = {};
  for (const reader of readers) for (const articleId of reader.readArticles ?? []) (readBy[String(articleId)] ??= []).push(reader.name);
  return { read: user?.readArticles ?? [], readBy };
}
```

  Update the controller's doc comment to "per article who read it".
- [ ] **Step 4:** `npx --yes bun test src/app.test.ts && npx --yes bun x tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(articles): read state names who read each article` + co-author line.

---

### Task 6: Full suite

- [ ] **Step 1:** `npx --yes bun test` → all pass; `npx --yes bun x tsc --noEmit` → clean; `npx --yes bun x eslint src` if the repo has an eslint config (check `package.json` scripts; run its lint script if present).
- [ ] **Step 2:** Do not merge or deploy: the client (plan `jotihunt-tracker-client/docs/superpowers/plans/2026-10-14-intel-window-client.md`) must ship together — the current client still calls `claim`/`presence`.
