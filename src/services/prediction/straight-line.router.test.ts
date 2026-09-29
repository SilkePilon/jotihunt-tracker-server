import { describe, expect, test } from "bun:test";
import { moveM } from "./geo";
import { straightLineRouter, straightLineSeconds } from "./straight-line.router";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];
const east = moveM(O, 1000, 0);

describe("straightLineRouter", () => {
  test("1 km straight = 1.3 km walking = 15.6 minutes at 5 km/h", async () => {
    expect(straightLineSeconds(O, east)).toBeCloseTo(936, -1);
    const matrix = await straightLineRouter.matrix([O], [east, O]);
    expect(matrix.durationsS[0][0]).toBeCloseTo(936, -1);
    expect(matrix.durationsS[0][1]).toBe(0);
    expect(matrix.distancesM[0][0]).toBeCloseTo(1300, -1);
  });
});
