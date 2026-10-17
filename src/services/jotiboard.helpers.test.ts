import { describe, expect, test } from "bun:test";
import { MarkerType } from "../models/marker.model";
import { hintSolveImports, isNearDuplicate, parseHintSolves, parsePins, pinImports } from "./jotiboard.helpers";

const T = Date.parse("2026-10-17T14:23:45.678Z");

describe("parsePins", () => {
  test("object keyed by id → pins; invalid entries dropped", () => {
    expect(parsePins(null)).toEqual([]);
    expect(
      parsePins({
        a: { foxAreas: ["Bravo"], lat: 52.29, lon: 5.61, time: T, type: "other", createdBy: "uid" },
        b: { foxAreas: ["Alpha"], lat: "x", lon: 5, time: T, type: "hunt" },
        c: { foxAreas: [], lat: 52, lon: 5, time: T, type: "hunt" },
        d: { foxAreas: ["Alpha"], lat: 52, lon: 5, time: T, type: "weird" },
      }),
    ).toEqual([{ id: "a", foxAreas: ["Bravo"], lat: 52.29, lon: 5.61, time: T, type: "other" }]);
  });
});

describe("pinImports", () => {
  test("one import per known area; type map; time to the minute", () => {
    const imports = pinImports([{ id: "p1", foxAreas: ["Bravo", "Charlie", "Zulu"], lat: 52.29, lon: 5.61, time: T, type: "other" }]);
    expect(imports).toEqual([
      { externalId: "p1", area: "bravo", type: MarkerType.Spot, time: new Date("2026-10-17T14:23:00.000Z"), coordinates: [5.61, 52.29] },
      { externalId: "p1", area: "charlie", type: MarkerType.Spot, time: new Date("2026-10-17T14:23:00.000Z"), coordinates: [5.61, 52.29] },
    ]);
  });
  test("hint pins are floored to the hour (like createMarker)", () => {
    const [hint] = pinImports([{ id: "p2", foxAreas: ["Alpha"], lat: 52, lon: 5, time: T, type: "hint" }]);
    expect(hint).toMatchObject({ type: MarkerType.Hint, time: new Date("2026-10-17T14:00:00.000Z") });
    const [hunt] = pinImports([{ id: "p3", foxAreas: ["Alpha"], lat: 52, lon: 5, time: T, type: "hunt" }]);
    expect(hunt.type).toBe(MarkerType.Hunt);
  });
});

describe("hint solves", () => {
  test("old entries: one x/y for their foxAreas, answer 'x y'", () => {
    const solves = parseHintSolves({
      "10": { messageId: 10, foxAreas: ["Alpha", "Bravo"], x: 123456, y: 456789, completed: true, enteredBy: "uid" },
      "12": { foxAreas: ["Alpha"], x: 123456, y: 456789, completed: true },
    });
    expect(hintSolveImports(solves)).toEqual([
      { messageId: 10, area: "alpha", answer: "123456 456789" },
      { messageId: 10, area: "bravo", answer: "123456 456789" },
      { messageId: 12, area: "alpha", answer: "123456 456789" },
    ]);
  });
  test("areaCoords: each area its own x/y, also when not all areas are filled in (completed false)", () => {
    const solves = parseHintSolves({
      "20": {
        messageId: 20,
        foxAreas: ["Alpha", "Bravo", "Charlie"],
        x: 123456,
        y: 456789,
        areaCoords: { Alpha: { x: 123456, y: 456789 }, Bravo: { x: 1876, y: 4632 }, Charlie: { x: 18765, y: 0 } },
        completed: false,
      },
    });
    expect(hintSolveImports(solves)).toEqual([
      { messageId: 20, area: "alpha", answer: "123456 456789" },
      { messageId: 20, area: "bravo", answer: "187600 463200" },
    ]);
  });
  test("messageId falls back to the key; entries without coordinates are skipped", () => {
    expect(parseHintSolves({ "7": { foxAreas: ["Alpha"], x: 1, y: 2, completed: false } })[0].messageId).toBe(7);
    expect(parseHintSolves({ "8": { foxAreas: ["Alpha"], x: "", y: "" } })).toEqual([]);
  });
});

describe("isNearDuplicate", () => {
  const base = { time: new Date(T), coordinates: [5.61, 52.29] };
  test("inside 15 min and 300 m", () => {
    expect(isNearDuplicate(base, { time: new Date(T + 15 * 60_000), coordinates: [5.612, 52.291] })).toBe(true);
  });
  test("too late or too far", () => {
    expect(isNearDuplicate(base, { time: new Date(T + 15 * 60_000 + 1), coordinates: [5.61, 52.29] })).toBe(false);
    expect(isNearDuplicate(base, { time: new Date(T), coordinates: [5.62, 52.29] })).toBe(false); // ~680 m
  });
});
