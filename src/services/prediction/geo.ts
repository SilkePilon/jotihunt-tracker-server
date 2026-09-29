import bearing from "@turf/bearing";
import circle from "@turf/circle";
import distance from "@turf/distance";
import { lineString, point } from "@turf/helpers";
import turfLength from "@turf/length";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { LngLat } from "./types";

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

const METERS_PER_DEGREE_LAT = 111_320;

/** Great-circle distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  return distance(a, b, { units: "meters" });
}

/** Initial compass bearing from a to b in degrees (-180..180, 0 = north). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  return bearing(a, b);
}

/** Smallest absolute difference between two bearings, 0..180 degrees. */
export function angleDiffDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** A circle as a GeoJSON polygon. */
export function circlePolygon(center: LngLat, radiusM: number): PolygonGeometry {
  const feature = circle(center, Math.max(radiusM, 1), { units: "meters", steps: 48 });
  return { type: "Polygon", coordinates: feature.geometry.coordinates };
}

/**
 * Distance from a point to a polyline, and where along the line (0..1) the closest point lies.
 */
export function pointToLine(p: LngLat, line: LngLat[]): { distanceM: number; fraction: number } {
  if (line.length < 2) return { distanceM: distanceM(p, line[0] ?? p), fraction: 0 };
  const feature = lineString(line);
  const total = turfLength(feature, { units: "meters" });
  const nearest = nearestPointOnLine(feature, point(p), { units: "meters" });
  return {
    distanceM: nearest.properties.pointDistance,
    fraction: total > 0 ? nearest.properties.lineDistance / total : 0,
  };
}

/** Move a coordinate by metres east/north (equirectangular, fine for a few km). */
export function moveM([lng, lat]: LngLat, eastM: number, northM: number): LngLat {
  const dLat = northM / METERS_PER_DEGREE_LAT;
  const dLng = eastM / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return [lng + dLng, lat + dLat];
}

/** Bounding box [west, south, east, north] around the points, padded by padM metres. */
export function paddedBbox(points: LngLat[], padM: number): [number, number, number, number] {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const [west, south] = moveM([Math.min(...lngs), Math.min(...lats)], -padM, -padM);
  const [east, north] = moveM([Math.max(...lngs), Math.max(...lats)], padM, padM);
  return [west, south, east, north];
}
