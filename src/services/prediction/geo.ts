import bearing from "@turf/bearing";
import distance from "@turf/distance";
import type { LngLat } from "./types";

const METERS_PER_DEGREE_LAT = 111_320;

/** Great-circle distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  return distance(a, b, { units: "meters" });
}

/** Initial compass bearing from a to b in degrees (-180..180, 0 = north). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  return bearing(a, b);
}

/** Move a coordinate by metres east/north (equirectangular, fine for a few km). */
export function moveM([lng, lat]: LngLat, eastM: number, northM: number): LngLat {
  const dLat = northM / METERS_PER_DEGREE_LAT;
  const dLng = eastM / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return [lng + dLng, lat + dLat];
}
