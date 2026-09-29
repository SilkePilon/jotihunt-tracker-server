import { describe, expect, test } from "bun:test";
import { bearingDeg, distanceM, moveM } from "./geo";
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
});
