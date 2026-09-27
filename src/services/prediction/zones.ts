import { DETOUR_FACTOR, ELAPSED_CAP_MIN, WALK_M_PER_MIN } from "./constants";
import { circlePolygon } from "./geo";
import { clamp } from "./learning";
import type { LngLat, PolygonGeometry } from "./types";

/** Isochrone ranges requested once per position (ORS allows at most 10 ranges per call). */
export const ISOCHRONE_RANGES_MIN = [5, 10, 15, 20, 25, 30, 40, 50, 60];
const ZONE_BUCKET_MIN = 10;

/** Minutes the team has been able to walk since leaving the last observed position. */
export function elapsedMinutes(now: Date, lastTime: Date, dwellMinutes: number): number {
  return clamp((now.getTime() - lastTime.getTime()) / 60_000 - dwellMinutes, [0, ELAPSED_CAP_MIN]);
}

/** Outer/core zone ranges in walking minutes, rounded up to 10-minute buckets. */
export function zoneRanges(elapsed: number, speedFactor: number): { outerMin: number; coreMin: number } {
  const outerMin = Math.max(ZONE_BUCKET_MIN, Math.ceil((elapsed * speedFactor) / ZONE_BUCKET_MIN) * ZONE_BUCKET_MIN);
  return { outerMin, coreMin: outerMin / 2 };
}

/** Straight-line radius reachable in the given walking minutes (5 km/h over a 1.3× detour). */
export function walkRadiusM(walkMinutes: number): number {
  return (walkMinutes * WALK_M_PER_MIN) / DETOUR_FACTOR;
}

export function circleZone(center: LngLat, walkMinutes: number): PolygonGeometry {
  return circlePolygon(center, walkRadiusM(walkMinutes));
}

/** The routed isochrone for these minutes, or a circle when there is none. */
export function pickRing(rings: Record<number, PolygonGeometry> | undefined, center: LngLat, minutes: number): PolygonGeometry {
  return rings?.[minutes] ?? circleZone(center, minutes);
}
