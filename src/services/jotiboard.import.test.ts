import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { JotiboardImport } from "../models/jotiboard-import.model";
import { Marker, MarkerType } from "../models/marker.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { solveCell } from "./hint-board.service";
import type { JotiboardHintSolve, JotiboardPin } from "./jotiboard.helpers";
import { jotiboardImporter as importer } from "./jotiboard.import";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const T = Date.parse("2026-10-17T14:20:00Z");
const pin = (overrides: Partial<JotiboardPin> = {}): JotiboardPin => ({ id: "p1", foxAreas: ["Bravo"], lat: 52.29, lon: 5.61, time: T, type: "other", ...overrides });
const solve = (overrides: Partial<JotiboardHintSolve> = {}): JotiboardHintSolve => ({ messageId: 10, foxAreas: ["Alpha"], x: 155000, y: 463000, completed: true, ...overrides });
const point = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] });
const cell = (area = "alpha") =>
  HintCell.create({ articleId: 10, area, publishAt: new Date("2026-10-17T14:00:00Z"), slotTime: new Date("2026-10-17T14:00:00Z") });

describe("pins", () => {
  test("imports a pin as a Jotiboard marker, once", async () => {
    await importer.importPins([pin()]);
    await importer.importPins([pin()]);
    const markers = await Marker.find().lean();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ area: "bravo", type: MarkerType.Spot, source: "jotiboard", externalId: "p1" });
    expect(await importer.counts()).toEqual({ pins: 1, hints: 0 });
  });

  test("skips a pin near one of our markers (same area + type)", async () => {
    await Marker.create({ area: "bravo", type: MarkerType.Spot, time: new Date(T + 10 * 60_000), location: point(5.611, 52.29) });
    await importer.importPins([pin()]);
    expect(await Marker.countDocuments()).toBe(1);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "duplicate" });
    expect(await importer.counts()).toEqual({ pins: 0, hints: 0 });
  });

  test("another type or area is not a duplicate", async () => {
    await Marker.create({ area: "bravo", type: MarkerType.Hunt, time: new Date(T), location: point(5.61, 52.29) });
    await Marker.create({ area: "alpha", type: MarkerType.Spot, time: new Date(T), location: point(5.61, 52.29) });
    await importer.importPins([pin()]);
    expect(await Marker.countDocuments({ source: "jotiboard" })).toBe(1);
  });

  test("a hint pin on an hour that already has a hint marker is skipped", async () => {
    await Marker.create({ area: "bravo", type: MarkerType.Hint, time: new Date("2026-10-17T14:00:00Z"), location: point(5.7, 52.4) });
    await importer.importPins([pin({ type: "hint" })]);
    expect(await Marker.countDocuments()).toBe(1);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "duplicate" });
  });

  test("a pin gone from Jotiboard removes only its imported marker", async () => {
    const ours = await Marker.create({ area: "bravo", type: MarkerType.Hunt, time: new Date(T), location: point(5.0, 52.0) });
    await importer.importPins([pin(), pin({ id: "p2", foxAreas: ["Alpha"] })]);
    await importer.importPins([pin({ id: "p2", foxAreas: ["Alpha"] })]);
    const left = await Marker.find().lean();
    expect(left.map((marker) => String(marker._id)).sort()).toEqual([String(ours._id), String((await Marker.findOne({ externalId: "p2" }))!._id)].sort());
    expect(await JotiboardImport.countDocuments({ externalId: "p1" })).toBe(0);
  });
});

describe("hint solves", () => {
  test("solves an open cell and places the hint marker", async () => {
    await cell();
    await importer.importHintSolves([solve()]);
    const stored = await HintCell.findOne().lean();
    expect(stored).toMatchObject({ status: HintCellStatus.Solved, answer: "155000 463000", answerKind: "rd" });
    expect(await Marker.countDocuments({ type: MarkerType.Hint })).toBe(1);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ kind: "hintSolve", result: "imported", answer: "155000 463000", cellId: stored!._id });
    expect(await importer.counts()).toEqual({ pins: 0, hints: 1 });
  });

  test("our solved cell wins", async () => {
    await cell();
    await solveCell(10, "alpha", "Kerk");
    await importer.importHintSolves([solve()]);
    expect((await HintCell.findOne().lean())?.answer).toBe("Kerk");
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "cell-solved" });
  });

  test("no cell yet: retried until the cell exists", async () => {
    await importer.importHintSolves([solve()]);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "no-cell" });
    await cell();
    await importer.importHintSolves([solve()]);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "imported" });
  });

  test("an existing hint marker of ours on that hour: skipped as duplicate", async () => {
    await cell();
    await Marker.create({ area: "alpha", type: MarkerType.Hint, time: new Date("2026-10-17T14:00:00Z"), location: point(5.7, 52.4) });
    await importer.importHintSolves([solve()]);
    expect((await HintCell.findOne().lean())?.status).toBe(HintCellStatus.Open);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "duplicate" });
  });
});

describe("purge", () => {
  test("removes imported markers and reopens imported cells, keeps ours, clears the records", async () => {
    const ours = await Marker.create({ area: "charlie", type: MarkerType.Spot, time: new Date(T), location: point(5.0, 52.0) });
    await cell("alpha");
    await cell("bravo");
    await solveCell(10, "bravo", "Molen");
    await importer.importPins([pin()]);
    await importer.importHintSolves([solve({ foxAreas: ["Alpha", "Bravo"] })]);

    expect(await importer.purge()).toEqual({ markers: 1, hints: 1 });
    expect((await Marker.find().lean()).map((marker) => String(marker._id))).toEqual([String(ours._id)]);
    const alpha = await HintCell.findOne({ area: "alpha" }).lean();
    expect(alpha?.status).toBe(HintCellStatus.Open);
    expect(alpha?.answer).toBeUndefined();
    expect(alpha?.markerId).toBeUndefined();
    expect((await HintCell.findOne({ area: "bravo" }).lean())?.answer).toBe("Molen");
    expect(await JotiboardImport.countDocuments()).toBe(0);
  });

  test("a cell we changed after the import is left alone", async () => {
    await cell();
    await importer.importHintSolves([solve()]);
    await solveCell(10, "alpha", "155100 463100");
    expect(await importer.purge()).toEqual({ markers: 0, hints: 0 });
    expect((await HintCell.findOne().lean())?.answer).toBe("155100 463100");
  });
});
