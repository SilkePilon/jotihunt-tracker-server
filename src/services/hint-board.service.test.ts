import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { addNote, claimCell, getBoard, HintBoardError, releaseCell, setCheck, setStatus, solveCell } from "./hint-board.service";

const slotTime = new Date("2026-10-17T12:00:00.000Z");

async function makeUser(name: string, admin = false) {
  return User.create({ email: `${name}@test.nl`, password: "x", name, admin });
}

async function makeCell(area = "alpha", status = HintCellStatus.Open) {
  return HintCell.create({ articleId: 1, area, publishAt: new Date("2026-10-17T12:02:00.000Z"), slotTime, status });
}

async function expectBoardError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HintBoardError);
    expect((error as HintBoardError).status).toBe(status);
    return error as HintBoardError;
  }
  throw new Error(`Expected HintBoardError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("getBoard", () => {
  test("returns hint articles newest first and populated cells", async () => {
    const user = await makeUser("merida");
    await Article.create([
      { id: 1, title: "Hint 1", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" },
      { id: 2, title: "Hint 2", type: "hint", publishAt: new Date("2026-10-17T13:00:00Z"), content: "b" },
      { id: 3, title: "Nieuws", type: "news", publishAt: new Date("2026-10-17T14:00:00Z"), content: "c" },
    ]);
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const board = await getBoard();
    expect(board.articles.map((article) => article.id)).toEqual([2, 1]);
    expect((board.cells[0].claimedBy as unknown as { name: string }).name).toBe("merida");
  });
});

describe("claimCell", () => {
  test("claims an open cell", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await claimCell(1, "alpha", user._id);
    expect(cell.status).toBe(HintCellStatus.Solving);
    expect(String(cell.claimedBy!._id)).toBe(String(user._id));
  });

  test("only one of two concurrent claims wins", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    const results = await Promise.allSettled([claimCell(1, "alpha", a._id), claimCell(1, "alpha", b._id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as HintBoardError).status).toBe(409);
  });

  test("the claimer can claim again", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const again = await claimCell(1, "alpha", user._id);
    expect(again.status).toBe(HintCellStatus.Solving);
  });

  test("409 with claimer name when claimed by someone else", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const error = await expectBoardError(claimCell(1, "alpha", b._id), 409);
    expect((error.details.claimedBy as { name: string }).name).toBe("a");
  });

  test("409 for a none cell, 404 for a missing cell", async () => {
    const user = await makeUser("merida");
    await makeCell("bravo", HintCellStatus.None);
    await expectBoardError(claimCell(1, "bravo", user._id), 409);
    await expectBoardError(claimCell(1, "golf", user._id), 404);
  });
});

describe("releaseCell", () => {
  test("claimer and admin can release, others cannot", async () => {
    const [a, b, admin] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("admin", true), makeCell()]);
    await claimCell(1, "alpha", a._id);
    await expectBoardError(releaseCell(1, "alpha", { _id: b._id, admin: false }), 409);
    const released = await releaseCell(1, "alpha", { _id: admin._id, admin: true });
    expect(released.status).toBe(HintCellStatus.Open);
    expect(released.claimedBy).toBeFalsy();
    await claimCell(1, "alpha", a._id);
    expect((await releaseCell(1, "alpha", { _id: a._id, admin: false })).status).toBe(HintCellStatus.Open);
  });
});

describe("solveCell", () => {
  test("RD answer creates a hint marker at the slot time", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await solveCell(1, "alpha", user._id, "2126 4692");
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
    const user = await makeUser("merida");
    await makeCell();
    const first = await solveCell(1, "alpha", user._id, "2126 4692");
    const second = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(String(second.markerId)).toBe(String(first.markerId));
    expect(await Marker.countDocuments()).toBe(1);
  });

  test("text answer creates no marker", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await solveCell(1, "alpha", user._id, "doedelzak");
    expect(cell.answerKind).toBe("text");
    expect(cell.markerId).toBeFalsy();
    expect(cell.answerLocation).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("409 when another hint marker exists for the slot, replace on request", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const manual = await Marker.create({
      area: "alpha",
      time: slotTime,
      type: MarkerType.Hint,
      location: { type: "Point", coordinates: [6, 52] },
    });
    const error = await expectBoardError(solveCell(1, "alpha", user._id, "2126 4692"), 409);
    expect(error.details.existingMarkerId).toBe(String(manual._id));

    const cell = await solveCell(1, "alpha", user._id, "2126 4692", true);
    expect(await Marker.exists({ _id: manual._id })).toBeNull();
    expect(await Marker.countDocuments()).toBe(1);
    expect(cell.markerId).toBeTruthy();
  });

  test("solving resets the check", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await solveCell(1, "alpha", user._id, "2126 4692");
    await setCheck(1, "alpha", user._id, HintCheck.Verified);
    const cell = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(cell.check).toBe(HintCheck.Unchecked);
  });
});

describe("setCheck, addNote, setStatus", () => {
  test("setCheck records who checked", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await setCheck(1, "alpha", user._id, HintCheck.Disputed);
    expect(cell.check).toBe(HintCheck.Disputed);
    expect((cell.checkedBy as unknown as { name: string }).name).toBe("merida");
  });

  test("addNote appends a note with the author", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await addNote(1, "alpha", user._id, "Lijkt Ogham");
    const cell = await addNote(1, "alpha", user._id, "Ja, Ogham");
    expect(cell.notes.map((note) => note.text)).toEqual(["Lijkt Ogham", "Ja, Ogham"]);
    expect((cell.notes[0].user as unknown as { name: string }).name).toBe("merida");
  });

  test("setStatus toggles none and clears the claim", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const cell = await setStatus(1, "alpha", HintCellStatus.None);
    expect(cell.status).toBe(HintCellStatus.None);
    expect(cell.claimedBy).toBeFalsy();
  });
});
