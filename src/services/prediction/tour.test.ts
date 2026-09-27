import { describe, expect, test } from "bun:test";
import { planTour, tourCost } from "./tour";

// Nodes on a line at x = 1, -2, 4; the start is at x = 0.
const xs = [1, -2, 4];
const startCosts = xs.map((x) => Math.abs(x));
const matrix = xs.map((a) => xs.map((b) => Math.abs(a - b)));

describe("planTour", () => {
  test("2-opt improves the nearest-neighbour tour", () => {
    // Nearest neighbour gives [0, 1, 2] (cost 10); reversing the first two gives [1, 0, 2] (cost 8).
    expect(tourCost([0, 1, 2], startCosts, matrix)).toBe(10);
    const tour = planTour(startCosts, matrix);
    expect(tour).toEqual([1, 0, 2]);
    expect(tourCost(tour, startCosts, matrix)).toBe(8);
  });

  test("handles empty and single-node input", () => {
    expect(planTour([], [])).toEqual([]);
    expect(planTour([5], [[0]])).toEqual([0]);
  });

  test("returns a permutation for asymmetric costs", () => {
    const tour = planTour([3, 1, 2], [
      [0, 5, 1],
      [2, 0, 9],
      [4, 1, 0],
    ]);
    expect([...tour].sort()).toEqual([0, 1, 2]);
  });
});
