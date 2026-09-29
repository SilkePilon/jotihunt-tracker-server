import { distanceM, moveM } from "../../services/prediction/geo";
import type { LngLat } from "../../services/prediction/types";
import { MINUTE_MS } from "./constants";
import type { Rng } from "./prng";

export interface RouteStop {
  position: LngLat;
  /** ms since epoch */
  arrive: number;
  depart: number;
}

export interface FoxRoute {
  stops: RouteStop[];
}

export interface RouteOptions {
  /** Walking foxes 4.5 km/h; Oscar travels by public transport */
  speedKmh: number;
  stopMinutes: number;
}

export const WALKING_FOX: RouteOptions = { speedKmh: 4.5, stopMinutes: 10 };
/** Oscar "jumps" between its groups by public transport: fast legs, longer waits at stops */
export const OSCAR_FOX: RouteOptions = { speedKmh: 25, stopMinutes: 20 };

/** Visiting order: nearest neighbour from `startIndex`. */
export function nearestNeighbourOrder(points: LngLat[], startIndex: number): number[] {
  if (points.length === 0) return [];
  const order = [startIndex];
  const left = new Set(points.map((_, index) => index).filter((index) => index !== startIndex));
  while (left.size) {
    const current = points[order[order.length - 1]];
    let best = -1;
    for (const index of left) if (best < 0 || distanceM(current, points[index]) < distanceM(current, points[best])) best = index;
    order.push(best);
    left.delete(best);
  }
  return order;
}

/** A few synthetic waypoints in a ring around `centre`, for areas with fewer than 3 groups. */
export function ringWaypoints(centre: LngLat, radiusM: number, count: number, rng: Rng): LngLat[] {
  const offset = rng.range(0, Math.PI * 2);
  return Array.from({ length: count }, (_, i) => {
    const angle = offset + (i / count) * Math.PI * 2;
    return moveM(centre, Math.cos(angle) * radiusM, Math.sin(angle) * radiusM);
  });
}

/**
 * A fox route from `start` until at least `until`: the groups in nearest-neighbour order from a random group, moving in
 * straight lines at `speedKmh` with a stop at every group; the tour repeats after the last group.
 */
export function buildFoxRoute(points: LngLat[], start: number, until: number, rng: Rng, options: RouteOptions): FoxRoute {
  if (points.length === 0) throw new Error("A fox route needs at least one point");
  const order = nearestNeighbourOrder(points, rng.int(0, points.length - 1));
  const speedMs = (options.speedKmh * 1000) / 3_600_000;
  const stops: RouteStop[] = [];
  let time = start;
  let i = 0;
  while (time <= until) {
    const position = points[order[i % order.length]];
    const previous = stops[stops.length - 1];
    const arrive = previous ? previous.depart + distanceM(previous.position, position) / speedMs : time;
    const depart = arrive + options.stopMinutes * MINUTE_MS;
    stops.push({ position, arrive, depart });
    time = depart;
    i++;
    // A single point: stay there
    if (order.length === 1) {
      stops[0].depart = Math.max(until, depart);
      break;
    }
  }
  return { stops };
}

/** Position on the route at `time` (ms): at a stop, or linearly between two stops. */
export function positionAt(route: FoxRoute, time: number): LngLat {
  const { stops } = route;
  if (time <= stops[0].depart) return stops[0].position;
  for (let i = 1; i < stops.length; i++) {
    const previous = stops[i - 1];
    const stop = stops[i];
    if (time < stop.arrive) {
      const fraction = (time - previous.depart) / (stop.arrive - previous.depart);
      return [previous.position[0] + (stop.position[0] - previous.position[0]) * fraction, previous.position[1] + (stop.position[1] - previous.position[1]) * fraction];
    }
    if (time <= stop.depart) return stop.position;
  }
  return stops[stops.length - 1].position;
}
