import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import { nextGeneration } from "../demo/demo-mode";
import { clearCell, getBoard, getBoardJson, invalidateBoardCache, reopenImportedCell, solveCell } from "./hint-board.service";

const slotTime = new Date("2026-10-17T12:00:00.000Z");

async function makeCell(area = "alpha", status = HintCellStatus.Open) {
  return HintCell.create({ articleId: 1, area, publishAt: new Date("2026-10-17T12:02:00.000Z"), slotTime, status });
}

async function expectBoardError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(status);
    return error as ServiceError;
  }
  throw new Error(`Expected ServiceError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

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

describe("solveCell", () => {
  test("RD answer creates a hint marker at the slot time", async () => {
    await makeCell();
    const cell = await solveCell(1, "alpha", "2126 4692");
    expect(cell.status).toBe(HintCellStatus.Solved);
    expect(cell.answerKind).toBe("rd");
    const marker = await Marker.findById(cell.markerId).lean();
    expect(marker!.area).toBe("alpha");
    expect(marker!.type).toBe(MarkerType.Hint);
    expect(marker!.time.toISOString()).toBe(slotTime.toISOString());
    expect(marker!.location.coordinates[1]).toBeCloseTo(52.2079, 3);
    expect(cell.answerLocation![1]).toBeCloseTo(52.2079, 3);
  });

  test("solving again moves the same marker", async () => {
    await makeCell();
    const first = await solveCell(1, "alpha", "2126 4692");
    const second = await solveCell(1, "alpha", "2000 4700");
    expect(String(second.markerId)).toBe(String(first.markerId));
    expect(await Marker.countDocuments()).toBe(1);
  });

  test("text answer creates no marker", async () => {
    await makeCell();
    const cell = await solveCell(1, "alpha", "doedelzak");
    expect(cell.answerKind).toBe("text");
    expect(cell.markerId).toBeFalsy();
    expect(cell.answerLocation).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("409 when another hint marker exists for the slot, replace on request", async () => {
    await makeCell();
    const manual = await Marker.create({
      area: "alpha",
      time: slotTime,
      type: MarkerType.Hint,
      location: { type: "Point", coordinates: [6, 52] },
    });
    const error = await expectBoardError(solveCell(1, "alpha", "2126 4692"), 409);
    expect(error.details.existingMarkerId).toBe(String(manual._id));

    const cell = await solveCell(1, "alpha", "2126 4692", true);
    expect(await Marker.exists({ _id: manual._id })).toBeNull();
    expect(await Marker.countDocuments()).toBe(1);
    expect(cell.markerId).toBeTruthy();
  });

  test("replacing a marker linked from another cell clears that cell's link", async () => {
    await makeCell("alpha");
    await makeCell("bravo");

    // bravo owns a marker at alpha's slot/area (simulates two areas sharing an hour slot
    // via a manually-created marker that a different cell then adopts).
    const manual = await Marker.create({
      area: "alpha",
      time: slotTime,
      type: MarkerType.Hint,
      location: { type: "Point", coordinates: [6, 52] },
    });
    await HintCell.updateOne({ articleId: 1, area: "bravo" }, { $set: { markerId: manual._id, answerLocation: [6, 52] } });

    const solved = await solveCell(1, "alpha", "2126 4692", true);
    expect(String(solved.markerId)).not.toBe(String(manual._id));
    expect(await Marker.exists({ _id: manual._id })).toBeNull();

    const bravoCell = await HintCell.findOne({ articleId: 1, area: "bravo" }).lean();
    expect(bravoCell!.markerId).toBeFalsy();
    expect(bravoCell!.answerLocation).toBeFalsy();
  });

  test("RD answer then text answer deletes the previously created marker", async () => {
    await makeCell();
    await solveCell(1, "alpha", "2126 4692");
    expect(await Marker.countDocuments()).toBe(1);
    const cell = await solveCell(1, "alpha", "doedelzak");
    expect(cell.answerKind).toBe("text");
    expect(cell.markerId).toBeFalsy();
    expect(cell.answerLocation).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("solveCell on a missing cell throws 404", async () => {
    await expectBoardError(solveCell(1, "golf", "doedelzak"), 404);
  });

  test("concurrent RD solves leave one marker at the stored answer", async () => {
    await makeCell();
    const results = await Promise.allSettled([
      solveCell(1, "alpha", "2126 4692"),
      solveCell(1, "alpha", "2000 4700"),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as ServiceError).status).toBe(409);
    }
    await expectConsistent("alpha");
  });

  test("RD vs RD on a cell with a marker: the marker always ends at the stored answer", async () => {
    await makeCell();
    for (let round = 0; round < 5; round++) {
      await solveCell(1, "alpha", "155000 463000");
      await Promise.all(Array.from({ length: 8 }, (_, i) => solveCell(1, "alpha", `${150000 + i * 100 + round} ${460000 + i * 100}`)));
      await expectConsistent("alpha");
    }
  });

  test("RD vs word on a fresh cell leaves no orphan hint marker", async () => {
    await makeCell();
    for (let round = 0; round < 12; round++) {
      await HintCell.updateOne({ area: "alpha" }, { $set: { status: HintCellStatus.Open }, $unset: { answer: 1, answerKind: 1, answerLocation: 1, markerId: 1 } });
      await Marker.deleteMany({});
      await Promise.all([
        solveCell(1, "alpha", "155000 463000"),
        Bun.sleep(round % 4).then(() => solveCell(1, "alpha", "woord")),
      ]);
      await expectConsistent("alpha");
    }
  });

  test("a deleted hint marker is recreated on the next solve", async () => {
    await makeCell();
    const first = await solveCell(1, "alpha", "2126 4692");
    await Marker.deleteOne({ _id: first.markerId });
    const again = await solveCell(1, "alpha", "2000 4700");
    expect(String(again.markerId)).not.toBe(String(first.markerId));
    await expectConsistent("alpha");
  });

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
});

/** The cell's marker matches its stored answer; no hint markers are left for a word answer. */
async function expectConsistent(area: string) {
  const cell = await HintCell.findOne({ articleId: 1, area }).lean();
  const markers = await Marker.find({ type: MarkerType.Hint, area, time: slotTime }).lean();
  if (cell!.answerKind === "rd") {
    expect(markers).toHaveLength(1);
    expect(String(markers[0]._id)).toBe(String(cell!.markerId));
    expect(markers[0].location.coordinates).toEqual(cell!.answerLocation!);
  } else {
    expect(markers).toHaveLength(0);
    expect(cell!.markerId).toBeFalsy();
  }
}

describe("solvedAt", () => {
  test("is set on the first solve and kept when the answer changes", async () => {
    await makeCell();
    const before = Date.now();
    const first = await solveCell(1, "alpha", "2126 4692");
    expect(first.solvedAt).toBeInstanceOf(Date);
    expect(first.solvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await solveCell(1, "alpha", "kerk");
    expect(second.solvedAt!.getTime()).toBe(first.solvedAt!.getTime());
  });

  test("an open cell has none", async () => {
    await makeCell();
    const board = await getBoard();
    expect(board.cells[0].solvedAt).toBeUndefined();
  });

  test("reopening an imported cell clears it", async () => {
    const cell = await makeCell();
    await solveCell(1, "alpha", "kerk");
    expect(await reopenImportedCell(cell._id, "kerk")).toBe(true);
    const stored = await HintCell.findById(cell._id).lean();
    expect(stored?.solvedAt).toBeUndefined();
  });

  test("an old solved cell without solvedAt gets its marker's creation time", async () => {
    const markerId = new mongoose.Types.ObjectId();
    await HintCell.create({ articleId: 1, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "x", answerKind: "rd", markerId });
    const board = await getBoard();
    expect(new Date(board.cells[0].solvedAt!).getTime()).toBe(markerId.getTimestamp().getTime());
  });

  test("an old solved text answer without marker stays without", async () => {
    await HintCell.create({ articleId: 1, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "kerk", answerKind: "text" });
    const board = await getBoard();
    expect(board.cells[0].solvedAt).toBeUndefined();
  });
});

describe("clearCell", () => {
  test("an RD answer: the cell is open again without answer or solvedAt, and its hint marker is gone", async () => {
    await makeCell();
    await solveCell(1, "alpha", "2126 4692");
    const cleared = await clearCell(1, "alpha");
    expect(cleared).toMatchObject({ status: HintCellStatus.Open });
    for (const field of ["answer", "answerKind", "answerLocation", "markerId", "solvedAt"]) expect(cleared).not.toHaveProperty(field);
    expect(await Marker.countDocuments({ type: MarkerType.Hint })).toBe(0);
  });

  test("a text answer is cleared too; an open cell stays as it is", async () => {
    await makeCell();
    await makeCell("bravo");
    await solveCell(1, "alpha", "kerk");
    expect(await clearCell(1, "alpha")).toMatchObject({ status: HintCellStatus.Open });
    expect(await clearCell(1, "bravo")).toMatchObject({ status: HintCellStatus.Open });
  });

  test("the board is rebuilt after clearing", async () => {
    await makeCell();
    await solveCell(1, "alpha", "kerk");
    await getBoardJson();
    await clearCell(1, "alpha");
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.Open);
  });

  test("a missing cell throws 404", async () => {
    await expectBoardError(clearCell(1, "alpha"), 404);
  });
});
