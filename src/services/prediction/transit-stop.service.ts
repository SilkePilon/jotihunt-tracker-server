import { Team } from "../../models/team.model";
import { TransitStop } from "../../models/transit-stop.model";
import { distanceM, paddedBbox } from "./geo";
import type { StopSource } from "./routing";
import type { LngLat } from "./types";

export const STOPS_PADDING_M = 10_000;

/**
 * Fetch public-transport stops within the bounding box of all groups + 10 km and replace the
 * stored ones. An empty result keeps the existing stops.
 * @param persist Runs the store step; background callers pass a demo-switch guard (`runTracked`) that may skip it
 * @returns The number of stored stops (0 when nothing changed or the store step was skipped)
 */
export async function refreshTransitStops(
  source: StopSource,
  persist: (store: () => Promise<number>) => Promise<number | undefined> = (store) => store(),
): Promise<number> {
  const teams = await Team.find({}, { location: 1 }).lean();
  const points = teams.map((team) => [team.location.coordinates[0], team.location.coordinates[1]] as LngLat);
  if (points.length === 0) return 0;
  const stops = await source.fetchStops(paddedBbox(points, STOPS_PADDING_M));
  if (stops.length === 0) return 0;
  const stored = await persist(async () => {
    await TransitStop.deleteMany({});
    await TransitStop.insertMany(
      stops.map((stop) => ({ osmId: stop.osmId, name: stop.name, kind: stop.kind, location: { type: "Point", coordinates: [stop.lng, stop.lat] } })),
    );
    return stops.length;
  });
  return stored ?? 0;
}

/** Metres to the nearest stored stop, Infinity when there are none. */
export async function nearestStopDistanceM(position: LngLat): Promise<number> {
  const stop = await TransitStop.findOne({ location: { $nearSphere: { $geometry: { type: "Point", coordinates: position } } } }).lean();
  if (!stop?.location) return Infinity;
  return distanceM(position, [stop.location.coordinates[0], stop.location.coordinates[1]]);
}
