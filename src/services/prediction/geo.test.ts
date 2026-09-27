import { describe, expect, test } from "bun:test";
import { angleDiffDeg, bearingDeg, circlePolygon, distanceM, moveM, paddedBbox, pointToLine } from "./geo";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];

describe("geo", () => {
  test("moveM and distanceM agree", () => {
    expect(distanceM(O, moveM(O, 1000, 0))).toBeCloseTo(1000, -1);
    expect(distanceM(O, moveM(O, 0, -2500))).toBeCloseTo(2500, -1);
  });

  test("bearingDeg points east / north", () => {
    expect(bearingDeg(O, moveM(O, 1000, 0))).toBeCloseTo(90, 0);
    expect(bearingDeg(O, moveM(O, 0, 1000))).toBeCloseTo(0, 0);
  });

  test("angleDiffDeg wraps around", () => {
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20, 6);
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180, 6);
    expect(angleDiffDeg(-90, 90)).toBeCloseTo(180, 6);
  });

  test("circlePolygon is a closed polygon at the radius", () => {
    const circle = circlePolygon(O, 800);
    expect(circle.type).toBe("Polygon");
    const ring = circle.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(distanceM(O, ring[0] as LngLat)).toBeCloseTo(800, -1);
  });

  test("pointToLine gives distance and fraction along the line", () => {
    const line: LngLat[] = [O, moveM(O, 2000, 0)];
    const result = pointToLine(moveM(O, 1000, 100), line);
    expect(result.distanceM).toBeCloseTo(100, -1);
    expect(result.fraction).toBeCloseTo(0.5, 2);
  });

  test("paddedBbox pads all sides", () => {
    const [west, south, east, north] = paddedBbox([O, moveM(O, 1000, 1000)], 10_000);
    expect(distanceM([west, O[1]], O)).toBeCloseTo(10_000, -2);
    expect(south).toBeLessThan(O[1]);
    expect(east).toBeGreaterThan(moveM(O, 1000, 0)[0]);
    expect(north).toBeGreaterThan(moveM(O, 0, 1000)[1]);
  });
});
