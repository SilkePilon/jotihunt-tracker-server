import { describe, expect, test } from "bun:test";
import destination from "@turf/destination";
import { combineTrails, measureSpeed, type SpeedLeg, type TrailInfo } from "./speed";

const t = (hhmm: string) => new Date(`2026-10-17T${hhmm}:00+02:00`);
const now = t("18:00");
const start: [number, number] = [5.9, 52.0];
/** A point `km` east of `from` (straight distance) */
const east = (from: [number, number], km: number) => destination(from, km, 90).geometry.coordinates as [number, number];

/** A leg walked at `kmh` over the straight distance × 1.2 (no trail) */
function leg(id: string, from: string, to: string, kmh: number): SpeedLeg {
  const hours = (t(to).getTime() - t(from).getTime()) / 3600_000;
  return { id, from: t(from), to: t(to), fromCoord: start, toCoord: east(start, (kmh * hours) / 1.2) };
}

describe("measureSpeed", () => {
  test("median of the legs, rounded to one decimal", () => {
    const legs = [leg("a", "12:00", "13:00", 4), leg("b", "13:00", "14:00", 5), leg("c", "14:00", "15:00", 4.6)];
    expect(measureSpeed(legs, null, [], now)).toEqual({ kmh: 4.6, measured: true, legs: 3 });
  });

  test("clamped to 3-7 km/h", () => {
    expect(measureSpeed([leg("a", "12:00", "13:00", 2), leg("b", "13:00", "14:00", 2)], null, [], now).kmh).toBe(3);
    expect(measureSpeed([leg("a", "12:00", "13:00", 7.8), leg("b", "13:00", "14:00", 7.9)], null, [], now).kmh).toBe(7);
  });

  test("fewer than two usable legs: 5 km/h, not measured", () => {
    expect(measureSpeed([leg("a", "12:00", "13:00", 4)], null, [], now)).toEqual({ kmh: 5, measured: false, legs: 1 });
    expect(measureSpeed([], null, [], now)).toEqual({ kmh: 5, measured: false, legs: 0 });
  });

  test("skips legs shorter than 10 minutes, older than 6 hours, and car-fast legs without a trail", () => {
    const legs = [leg("short", "15:00", "15:05", 4), leg("old", "10:00", "11:30", 4), leg("car", "15:10", "15:40", 30), leg("a", "16:00", "17:00", 4), leg("b", "17:00", "17:50", 6)];
    expect(measureSpeed(legs, null, [], now)).toEqual({ kmh: 5, measured: true, legs: 2 });
  });

  test("skips legs with more than 30 minutes red", () => {
    const legs = [leg("red", "12:00", "14:00", 3), leg("a", "14:00", "15:00", 5), leg("b", "15:00", "16:00", 6)];
    const events = [{ status: "green", at: t("09:00") }, { status: "red", at: t("12:30") }, { status: "green", at: t("13:15") }];
    expect(measureSpeed(legs, null, events, now)).toEqual({ kmh: 5.5, measured: true, legs: 2 });
  });

  test("trails: only walk legs, with the routed distance", () => {
    const legs = [leg("a", "12:00", "13:00", 4), leg("b", "13:00", "14:00", 4), leg("c", "14:00", "15:00", 4)];
    const trails = new Map<string, TrailInfo>([
      ["a", { mode: "walk", distanceM: 6000 }],
      ["b", { mode: "car", distanceM: 20000 }],
      ["c", { mode: "walk", distanceM: null }],
    ]);
    // a: 6 km/h routed, b: skipped, c: no route so straight × 1.2 = 4 km/h
    expect(measureSpeed(legs, trails, [], now)).toEqual({ kmh: 5, measured: true, legs: 2 });
  });
});

describe("combineTrails", () => {
  const trails = new Map<string, TrailInfo>([
    ["a:s", { mode: "walk", distanceM: 1200 }],
    ["s:b", { mode: "walk", distanceM: 800 }],
    ["s:c", { mode: "car", distanceM: 5000 }],
    ["s:d", { mode: "walk", distanceM: null }],
  ]);

  test("all walk: distances summed", () => {
    expect(combineTrails(["a:s", "s:b"], trails)).toEqual({ mode: "walk", distanceM: 2000 });
  });

  test("one car piece: the whole leg is car", () => {
    expect(combineTrails(["a:s", "s:c"], trails)).toEqual({ mode: "car", distanceM: 6200 });
  });

  test("a missing piece: null", () => {
    expect(combineTrails(["a:s", "s:x"], trails)).toBeNull();
    expect(combineTrails([], trails)).toBeNull();
  });

  test("a piece without distance: distanceM null", () => {
    expect(combineTrails(["a:s", "s:d"], trails)).toEqual({ mode: "walk", distanceM: null });
  });
});
