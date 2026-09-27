import { ELAPSED_CAP_MIN, MAX_ISLANDS, STOP_RADIUS_M } from "./constants";
import type { TransitItinerary } from "./routing";

export interface TravelChoice {
  travelMinutes: number;
  via: "walk" | "transit";
  transitLabel?: string;
}

export interface IslandStop {
  name: string;
  lng: number;
  lat: number;
  arrival: Date;
}

/** Public-transport mode: last observation near a stop, status orange, or area oscar (always). */
export function isTransitMode({ area, status, nearestStopDistanceM }: { area: string; status: string; nearestStopDistanceM: number }): boolean {
  return area.toLowerCase() === "oscar" || status === "orange" || nearestStopDistanceM < STOP_RADIUS_M;
}

/** Dutch name for a Transitous mode. */
export function transitKind(mode: string): string {
  if (mode === "SUBWAY" || mode === "METRO") return "metro";
  if (mode.includes("RAIL") || mode === "TRAIN") return "trein";
  if (mode === "TRAM") return "tram";
  if (mode === "FERRY") return "boot";
  if (mode === "BUS" || mode === "COACH") return "bus";
  return "ov";
}

/** "bus 80 → trein Intercity", or null when nothing is ridden. */
export function transitLabel(itinerary: TransitItinerary): string | null {
  const rides = itinerary.legs.filter((leg) => leg.mode !== "WALK");
  if (rides.length === 0) return null;
  return rides.map((leg) => `${transitKind(leg.mode)}${leg.line ? ` ${leg.line}` : ""}`).join(" → ");
}

/** Minutes from the planned departure until arrival (includes waiting for the first vehicle). */
export function transitMinutes(itinerary: TransitItinerary, departAt: Date): number {
  return (new Date(itinerary.endTime).getTime() - departAt.getTime()) / 60_000;
}

/** min(walking, public transport). */
export function chooseTravel(walkMinutes: number, itinerary: TransitItinerary | null, departAt: Date): TravelChoice {
  const walk: TravelChoice = { travelMinutes: walkMinutes, via: "walk" };
  if (!itinerary) return walk;
  const label = transitLabel(itinerary);
  if (!label) return walk;
  const minutes = transitMinutes(itinerary, departAt);
  return minutes < walkMinutes ? { travelMinutes: minutes, via: "transit", transitLabel: label } : walk;
}

/** Stops where the team gets off a vehicle in the fetched itineraries. */
export function alightingStops(itineraries: TransitItinerary[]): IslandStop[] {
  return itineraries.flatMap((itinerary) =>
    itinerary.legs
      .filter((leg) => leg.mode !== "WALK" && leg.to.arrival)
      .map((leg) => ({ name: leg.to.name, lng: leg.to.lng, lat: leg.to.lat, arrival: new Date(leg.to.arrival as Date) })),
  );
}

/** Reached stops (arrival ≤ now), one per location, largest remaining time first, at most `max`. */
export function selectIslands(stops: IslandStop[], now: Date, max = MAX_ISLANDS): { stop: IslandStop; remainingMinutes: number }[] {
  const best = new Map<string, { stop: IslandStop; remainingMinutes: number }>();
  for (const stop of stops) {
    const remaining = (now.getTime() - stop.arrival.getTime()) / 60_000;
    if (remaining < 0) continue;
    const key = `${stop.lng.toFixed(5)},${stop.lat.toFixed(5)}`;
    const entry = { stop, remainingMinutes: Math.min(remaining, ELAPSED_CAP_MIN) };
    const existing = best.get(key);
    if (!existing || existing.remainingMinutes < entry.remainingMinutes) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => b.remainingMinutes - a.remainingMinutes).slice(0, max);
}
