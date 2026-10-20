import bearing from "@turf/bearing";
import circle from "@turf/circle";
import distance from "@turf/distance";
import { feature, featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import sector from "@turf/sector";
import simplify from "@turf/simplify";

export type AreaGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;
export interface Group { teamApiId: number; name: string; coord: [number, number] }
export interface ConeTarget { teamApiId: number; name: string; bearing: number; distanceM: number }

/** Half the cone's opening */
export const CONE_HALF_ANGLE = 30;
/** ~15 m in degrees: isochrones come back with a point every few metres */
const SIMPLIFY_TOLERANCE = 0.00015;

/** Fallback area without a router: a circle of the walking distance. */
export function reachCircle(center: [number, number], distanceM: number): GeoJSON.Polygon {
  return circle(center, distanceM, { units: "meters", steps: 64 }).geometry;
}

export function simplifyArea(area: AreaGeometry): AreaGeometry {
  return simplify(feature(area), { tolerance: SIMPLIFY_TOLERANCE, highQuality: false }).geometry;
}

/** The nearest group (straight distance) not in `visited`. */
export function nearestUnvisited(fix: [number, number], groups: Group[], visited: Set<number>): ConeTarget | null {
  let best: ConeTarget | null = null;
  for (const group of groups) {
    if (visited.has(group.teamApiId)) continue;
    const distanceM = distance(fix, group.coord, { units: "meters" });
    if (!best || distanceM < best.distanceM) best = { teamApiId: group.teamApiId, name: group.name, bearing: bearing(fix, group.coord), distanceM };
  }
  return best && { ...best, distanceM: Math.round(best.distanceM) };
}

/** The ±CONE_HALF_ANGLE wedge from the fix toward the target, cut to the area; null when they do not overlap. */
export function coneIn(fix: [number, number], target: ConeTarget, area: AreaGeometry, radiusM: number): AreaGeometry | null {
  const wedge = sector(fix, radiusM, target.bearing - CONE_HALF_ANGLE, target.bearing + CONE_HALF_ANGLE, { units: "meters", steps: 32 });
  return intersect(featureCollection([wedge, feature(area)]))?.geometry ?? null;
}
