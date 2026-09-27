import { describe, expect, test } from "bun:test";
import { distanceM, moveM } from "./geo";
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

  test("route is the straight segment", async () => {
    const route = await straightLineRouter.route(O, east);
    expect(route.line).toEqual([O, east]);
    expect(route.distanceM).toBeCloseTo(1300, -1);
  });

  test("isochrones are circles keyed by minutes", async () => {
    const rings = await straightLineRouter.isochrones(O, [5, 10]);
    expect(Object.keys(rings).map(Number)).toEqual([5, 10]);
    expect(distanceM(O, rings[10].coordinates[0][0] as LngLat)).toBeCloseTo(641, -1);
  });
});
