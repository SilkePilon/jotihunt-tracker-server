import { describe, expect, test } from "bun:test";
import { distanceM } from "../../services/prediction/geo";
import type { LngLat } from "../../services/prediction/types";
import { MINUTE_MS } from "./constants";
import { buildFoxRoute, nearestNeighbourOrder, positionAt, WALKING_FOX } from "./fox-routes";
import { createRng } from "./prng";

const start = Date.parse("2026-10-17T09:00:00Z");
const points: LngLat[] = [
  [5.9, 52.1],
  [5.95, 52.1],
  [5.95, 52.14],
  [5.9, 52.14],
];

describe("fox routes", () => {
  test("nearest-neighbour order visits every point once", () => {
    expect(nearestNeighbourOrder(points, 0)).toEqual([0, 1, 2, 3]);
    expect(nearestNeighbourOrder(points, 2).sort()).toEqual([0, 1, 2, 3]);
  });

  test("covers the requested time with stops of 10 minutes and legs at 4.5 km/h", () => {
    const route = buildFoxRoute(points, start, start + 8 * 3_600_000, createRng(1), WALKING_FOX);
    expect(route.stops[0].arrive).toBe(start);
    expect(route.stops[route.stops.length - 1].depart).toBeGreaterThan(start + 8 * 3_600_000);
    for (let i = 1; i < route.stops.length; i++) {
      const previous = route.stops[i - 1];
      const stop = route.stops[i];
      expect(stop.depart - stop.arrive).toBe(10 * MINUTE_MS);
      const kmh = distanceM(previous.position, stop.position) / 1000 / ((stop.arrive - previous.depart) / 3_600_000);
      expect(kmh).toBeCloseTo(4.5, 5);
    }
  });

  test("interpolates: at a stop during the stop, halfway between stops halfway the leg, never faster than walking", () => {
    const route = buildFoxRoute(points, start, start + 8 * 3_600_000, createRng(1), WALKING_FOX);
    const [a, b] = route.stops;
    expect(positionAt(route, a.arrive + 5 * MINUTE_MS)).toEqual(a.position);
    expect(positionAt(route, start - 3_600_000)).toEqual(a.position);
    const middle = positionAt(route, (a.depart + b.arrive) / 2);
    expect(distanceM(middle, a.position)).toBeCloseTo(distanceM(middle, b.position), -1);
    for (let t = start; t < start + 6 * 3_600_000; t += 5 * MINUTE_MS) {
      const moved = distanceM(positionAt(route, t), positionAt(route, t + 5 * MINUTE_MS));
      expect(moved).toBeLessThanOrEqual((4.5 * 1000 * 5) / 60 + 1);
    }
  });

  test("a single point: the fox stays there", () => {
    const route = buildFoxRoute([points[0]], start, start + 3_600_000, createRng(1), WALKING_FOX);
    expect(positionAt(route, start + 30 * MINUTE_MS)).toEqual(points[0]);
  });
});
