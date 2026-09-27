import { describe, expect, test } from "bun:test";
import { distanceM, moveM } from "./geo";
import type { LngLat } from "./types";
import { circleZone, elapsedMinutes, pickRing, walkRadiusM, zoneRanges } from "./zones";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe("zones", () => {
  test("elapsed = now − last observation − dwell, within 0–120", () => {
    expect(elapsedMinutes(at(50), at(0), 15)).toBe(35);
    expect(elapsedMinutes(at(300), at(0), 15)).toBe(120);
    expect(elapsedMinutes(at(10), at(0), 15)).toBe(0);
  });

  test("zone ranges use 10-minute buckets and the speed factor", () => {
    expect(zoneRanges(35, 1)).toEqual({ outerMin: 40, coreMin: 20 });
    expect(zoneRanges(0, 1)).toEqual({ outerMin: 10, coreMin: 5 });
    expect(zoneRanges(35, 1.6)).toEqual({ outerMin: 60, coreMin: 30 });
    expect(zoneRanges(120, 1.6)).toEqual({ outerMin: 200, coreMin: 100 });
  });

  test("walking radius = minutes × 5 km/h ÷ 1.3", () => {
    expect(walkRadiusM(13)).toBeCloseTo(833.33, 1);
    const ring = circleZone(O, 13).coordinates[0];
    expect(distanceM(O, ring[0] as LngLat)).toBeCloseTo(833.33, -1);
  });

  test("pickRing prefers the routed ring and falls back to a circle", () => {
    const routed = circleZone(moveM(O, 5000, 0), 1);
    expect(pickRing({ 10: routed }, O, 10)).toBe(routed);
    const fallback = pickRing({ 10: routed }, O, 70);
    expect(fallback.type).toBe("Polygon");
    expect(distanceM(O, fallback.coordinates[0][0] as LngLat)).toBeCloseTo(walkRadiusM(70), -1);
    expect(pickRing(undefined, O, 10).type).toBe("Polygon");
  });
});
