import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import { nextGeneration } from "../demo/demo-mode";
import { addNote, claimCell, getBoard, getBoardJson, invalidateBoardCache, releaseCell, setCheck, setStatus, solveCell } from "./hint-board.service";

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

describe("getBoard JSON", () => {
  const populateUsers = [
    { path: "claimedBy", select: "name" },
    { path: "checkedBy", select: "name" },
    { path: "notes.user", select: "name" },
  ];

  test("is identical to the populate()-based board, also for deleted users", async () => {
    const [a, b, gone] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("gone"), makeCell("alpha"), makeCell("bravo"), makeCell("charlie")]);
    await Article.create({ id: 1, title: "Hint 1", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" });
    await claimCell(1, "alpha", a._id);
    await solveCell(1, "bravo", b._id, "2126 4692");
    await setCheck(1, "bravo", a._id, HintCheck.Verified);
    await addNote(1, "bravo", gone._id, "weg");
    await addNote(1, "bravo", a._id, "hier");
    await claimCell(1, "charlie", gone._id);
    await User.deleteOne({ _id: gone._id });

    const articles = await Article.find({ type: "hint" }, { _id: 0, id: 1, title: 1, publishAt: 1, content: 1 }).sort({ publishAt: -1 }).lean();
    const cells = await HintCell.find().populate(populateUsers).lean();
    invalidateBoardCache();
    expect(await getBoardJson()).toBe(JSON.stringify({ articles, cells }));
  });

  test("is shared for a moment, rebuilt after a write or a database switch", async () => {
    const user = await makeUser("merida");
    await makeCell();
    invalidateBoardCache();
    const first = await getBoardJson();
    // A write that bypasses the service is not seen while cached
    await HintCell.updateOne({ area: "alpha" }, { $set: { snippet: "stil" } });
    expect(await getBoardJson()).toBe(first);
    nextGeneration();
    const afterSwitch = await getBoardJson();
    expect(afterSwitch).toContain("stil");
    await claimCell(1, "alpha", user._id);
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.Solving);
  });

  test("concurrent requests share one build", async () => {
    await makeCell();
    invalidateBoardCache();
    const [x, y] = [getBoardJson(), getBoardJson()];
    expect(x).toBe(y);
    await x;
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
    expect((rejected.reason as ServiceError).status).toBe(409);
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

  test("replacing a marker linked from another cell clears that cell's link", async () => {
    const user = await makeUser("merida");
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

    const solved = await solveCell(1, "alpha", user._id, "2126 4692", true);
    expect(String(solved.markerId)).not.toBe(String(manual._id));
    expect(await Marker.exists({ _id: manual._id })).toBeNull();

    const bravoCell = await HintCell.findOne({ articleId: 1, area: "bravo" }).lean();
    expect(bravoCell!.markerId).toBeFalsy();
    expect(bravoCell!.answerLocation).toBeFalsy();
  });

  test("solving resets the check", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await solveCell(1, "alpha", user._id, "2126 4692");
    await setCheck(1, "alpha", user._id, HintCheck.Verified);
    const cell = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(cell.check).toBe(HintCheck.Unchecked);
  });

  test("RD answer then text answer deletes the previously created marker", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await solveCell(1, "alpha", user._id, "2126 4692");
    expect(await Marker.countDocuments()).toBe(1);
    const cell = await solveCell(1, "alpha", user._id, "doedelzak");
    expect(cell.answerKind).toBe("text");
    expect(cell.markerId).toBeFalsy();
    expect(cell.answerLocation).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("solveCell on a missing cell throws 404", async () => {
    const user = await makeUser("merida");
    await expectBoardError(solveCell(1, "golf", user._id, "doedelzak"), 404);
  });

  test("concurrent RD solves leave one marker at the stored answer", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    const results = await Promise.allSettled([
      solveCell(1, "alpha", a._id, "2126 4692", false, true),
      solveCell(1, "alpha", b._id, "2000 4700", false, true),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as ServiceError).status).toBe(409);
    }
    await expectConsistent("alpha");
  });

  test("RD vs RD on a cell with a marker: the marker always ends at the stored answer", async () => {
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => makeUser(`u${i}`)));
    await makeCell();
    for (let round = 0; round < 5; round++) {
      await solveCell(1, "alpha", users[0]._id, "155000 463000", false, true);
      await Promise.all(users.map((user, i) => solveCell(1, "alpha", user._id, `${150000 + i * 100 + round} ${460000 + i * 100}`, false, true)));
      await expectConsistent("alpha");
    }
  });

  test("RD vs word on a fresh cell leaves no orphan hint marker", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    for (let round = 0; round < 12; round++) {
      await HintCell.updateOne({ area: "alpha" }, { $set: { status: HintCellStatus.Open }, $unset: { answer: 1, answerKind: 1, answerLocation: 1, markerId: 1 } });
      await Marker.deleteMany({});
      await Promise.all([
        solveCell(1, "alpha", a._id, "155000 463000", false, true),
        Bun.sleep(round % 4).then(() => solveCell(1, "alpha", b._id, "woord", false, true)),
      ]);
      await expectConsistent("alpha");
    }
  });

  test("a deleted hint marker is recreated on the next solve", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const first = await solveCell(1, "alpha", user._id, "2126 4692");
    await Marker.deleteOne({ _id: first.markerId });
    const again = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(String(again.markerId)).not.toBe(String(first.markerId));
    await expectConsistent("alpha");
  });

  test("with overwrite anyone may answer a cell claimed by someone else", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const cell = await solveCell(1, "alpha", b._id, "doedelzak", false, true);
    expect(cell.status).toBe(HintCellStatus.Solved);
    expect((cell.claimedBy as unknown as { name: string }).name).toBe("b");
  });
});

describe("overwrite guard", () => {
  test("solving a cell someone else solved is a 409 that names the current answer", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    await solveCell(1, "alpha", a._id, "doedelzak");
    const error = await expectBoardError(solveCell(1, "alpha", b._id, "haggis"), 409);
    expect(error.message).toBe("Dit vak is al opgelost door iemand anders");
    const conflict = error.details.conflict as { kind: string; value: string; by: { _id: string; name: string }; at: Date };
    expect(conflict.kind).toBe("answer");
    expect(conflict.value).toBe("doedelzak");
    expect(conflict.by).toEqual({ _id: String(a._id), name: "sanne" });
    expect(conflict.at).toBeInstanceOf(Date);
    const cell = await HintCell.findOne({ articleId: 1, area: "alpha" }).lean();
    expect(cell?.answer).toBe("doedelzak");
    expect(String(cell?.claimedBy)).toBe(String(a._id));
  });

  test("with overwrite the new answer wins and the solver becomes the owner", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    await solveCell(1, "alpha", a._id, "doedelzak");
    const cell = await solveCell(1, "alpha", b._id, "haggis", false, true);
    expect(cell.answer).toBe("haggis");
    expect((cell.claimedBy as unknown as { name: string }).name).toBe("daan");
  });

  test("solving your own solved cell again needs no confirmation", async () => {
    const [a] = await Promise.all([makeUser("sanne"), makeCell()]);
    await solveCell(1, "alpha", a._id, "doedelzak");
    expect((await solveCell(1, "alpha", a._id, "haggis")).answer).toBe("haggis");
  });

  test("solving a cell someone else is working on is a claim conflict", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const error = await expectBoardError(solveCell(1, "alpha", b._id, "haggis"), 409);
    expect(error.message).toBe("Iemand anders is met dit vak bezig");
    expect(error.details.conflict).toMatchObject({ kind: "claim", value: null, by: { name: "sanne" } });
    expect((await solveCell(1, "alpha", b._id, "haggis", false, true)).answer).toBe("haggis");
  });

  test("claiming a cell someone else claimed is a claim conflict; overwrite takes it over", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const error = await expectBoardError(claimCell(1, "alpha", b._id), 409);
    expect(error.message).toBe("Dit vak is al geclaimd");
    expect(error.details.conflict).toMatchObject({ kind: "claim", by: { name: "sanne" } });
    expect((error.details.claimedBy as { name: string }).name).toBe("sanne");
    const cell = await claimCell(1, "alpha", b._id, true);
    expect((cell.claimedBy as unknown as { name: string }).name).toBe("daan");
    expect(cell.status).toBe(HintCellStatus.Solving);
  });

  test("overwrite does not open a solved or none cell for claiming", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    await solveCell(1, "alpha", a._id, "doedelzak");
    await expectBoardError(claimCell(1, "alpha", b._id, true), 409);
  });

  test("two users solving an open cell at once: one wins, the other gets the conflict", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeCell()]);
    const results = await Promise.allSettled([solveCell(1, "alpha", a._id, "doedelzak"), solveCell(1, "alpha", b._id, "haggis")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ServiceError).status).toBe(409);
    expect((rejected.reason as ServiceError).details.conflict).toMatchObject({ kind: "answer" });
    const cell = await HintCell.findOne({ articleId: 1, area: "alpha" }).lean();
    const winner = results[0].status === "fulfilled" ? "doedelzak" : "haggis";
    expect(cell?.answer).toBe(winner);
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

describe("setCheck, addNote, setStatus", () => {
  test("setCheck records who checked", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await setCheck(1, "alpha", user._id, HintCheck.Disputed);
    expect(cell.check).toBe(HintCheck.Disputed);
    expect((cell.checkedBy as unknown as { name: string }).name).toBe("merida");
  });

  test("setCheck with Unchecked clears checkedBy", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const checked = await setCheck(1, "alpha", user._id, HintCheck.Verified);
    expect(checked.checkedBy).toBeTruthy();
    const cell = await setCheck(1, "alpha", user._id, HintCheck.Unchecked);
    expect(cell.check).toBe(HintCheck.Unchecked);
    expect(cell.checkedBy).toBeFalsy();
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
    const cell = await setStatus(1, "alpha", HintCellStatus.None, { _id: user._id, admin: false });
    expect(cell.status).toBe(HintCellStatus.None);
    expect(cell.claimedBy).toBeFalsy();
    expect((await setStatus(1, "alpha", HintCellStatus.Open, { _id: user._id, admin: false })).status).toBe(HintCellStatus.Open);
  });

  test("setStatus on a cell claimed by someone else: 409 with the claimer, admins may", async () => {
    const [a, b, admin] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("admin", true), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const error = await expectBoardError(setStatus(1, "alpha", HintCellStatus.None, { _id: b._id, admin: false }), 409);
    expect(error.message).toBe("Dit vak is niet door jou geclaimd");
    expect((error.details.claimedBy as { name: string }).name).toBe("a");
    expect((await HintCell.findOne({ area: "alpha" }).lean())!.status).toBe(HintCellStatus.Solving);
    expect((await setStatus(1, "alpha", HintCellStatus.None, { _id: admin._id, admin: true })).status).toBe(HintCellStatus.None);
  });

  test("setStatus on an unclaimed open cell works for anyone", async () => {
    const user = await makeUser("merida");
    await makeCell();
    expect((await setStatus(1, "alpha", HintCellStatus.None, { _id: user._id, admin: false })).status).toBe(HintCellStatus.None);
  });

  test("setStatus leaves a solved cell alone; an admin clears answer and marker", async () => {
    const [user, admin] = await Promise.all([makeUser("merida"), makeUser("admin", true), makeCell()]);
    await solveCell(1, "alpha", user._id, "2126 4692");
    await expectBoardError(setStatus(1, "alpha", HintCellStatus.None, { _id: user._id, admin: false }), 409);
    const cell = await setStatus(1, "alpha", HintCellStatus.None, { _id: admin._id, admin: true });
    expect(cell.status).toBe(HintCellStatus.None);
    expect(cell.answer).toBeFalsy();
    expect(cell.answerKind).toBeFalsy();
    expect(cell.answerLocation).toBeFalsy();
    expect(cell.markerId).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("solve vs status none: never a non-solved cell with an answer", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser(`u${i}`)));
    await makeCell();
    for (let round = 0; round < 6; round++) {
      await HintCell.updateOne({ area: "alpha" }, { $set: { status: HintCellStatus.Open }, $unset: { answer: 1, answerKind: 1, claimedBy: 1 } });
      await Promise.allSettled(
        users.map((user, i) =>
          i % 2 ? solveCell(1, "alpha", user._id, `woord${i}`) : setStatus(1, "alpha", HintCellStatus.None, { _id: user._id, admin: false }),
        ),
      );
      const cell = await HintCell.findOne({ area: "alpha" }).lean();
      if (cell!.status !== HintCellStatus.Solved) expect(cell!.answer).toBeFalsy();
    }
  });
});
