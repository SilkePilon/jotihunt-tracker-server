import { DETOUR_FACTOR, WALK_M_PER_MIN } from "./constants";
import { distanceM } from "./geo";
import type { WalkingRouter } from "./routing";
import type { LngLat } from "./types";

/** Walking time estimate: straight line × 1.3 at 5 km/h, in seconds. */
export function straightLineSeconds(a: LngLat, b: LngLat): number {
  return ((distanceM(a, b) * DETOUR_FACTOR) / WALK_M_PER_MIN) * 60;
}

/** Fallback router used when ORS is unavailable (and as the routing mock in tests). */
export const straightLineRouter: WalkingRouter = {
  async matrix(sources, destinations) {
    return {
      durationsS: sources.map((source) => destinations.map((destination) => straightLineSeconds(source, destination))),
      distancesM: sources.map((source) => destinations.map((destination) => distanceM(source, destination) * DETOUR_FACTOR)),
    };
  },
};
