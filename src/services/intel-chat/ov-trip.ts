import { fromRd, toRd } from "../rd-answer";
import type { LatLng } from "./geo";
import type { OvMode } from "./ov.client";

/** One stop of a vehicle's run (bus/tram ride or train), times as Dates */
export interface TripStop {
  name: string;
  town: string | null;
  latLng: LatLng | null;
  plannedArr: Date | null;
  /** Expected (actual) arrival */
  arr: Date | null;
  plannedDep: Date | null;
  /** Expected (actual) departure */
  dep: Date | null;
  cancelled: boolean;
  /** Source id to find the boarding stop: NS UIC code, OVapi stop area code */
  key?: string;
  /** Position or time is an estimate (OVapi has no stop list) */
  estimated?: boolean;
}

export interface Trip {
  mode: OvMode;
  line: string;
  destination: string;
  stops: TripStop[];
  /** Part of the run is estimated */
  estimated: boolean;
  journeyId: string;
}

export type TripStatus = "PASSED" | "ARRIVED" | "DEPARTED" | "DRIVING" | "PLANNED" | "CANCEL" | "UNKNOWN";

export const arrivalAt = (stop: TripStop) => stop.arr ?? stop.dep;
export const departAt = (stop: TripStop) => stop.dep ?? stop.arr;

/** Status per stop at `now`: PASSED (left), DEPARTED (the stop just left), ARRIVED (standing there / terminus reached), DRIVING (heading there), PLANNED, CANCEL, UNKNOWN */
export function stopStatuses(trip: Trip, now: Date): TripStatus[] {
  const t = now.getTime();
  const last = trip.stops.length - 1;
  const statuses: TripStatus[] = trip.stops.map((stop, index) => {
    if (stop.cancelled) return "CANCEL";
    const arrival = arrivalAt(stop);
    const departure = departAt(stop);
    if (!arrival || !departure) return "UNKNOWN";
    if (index === last) return arrival.getTime() <= t ? "ARRIVED" : "PLANNED";
    if (departure.getTime() <= t) return "PASSED";
    return arrival.getTime() <= t && index > 0 ? "ARRIVED" : "PLANNED";
  });
  const next = statuses.findIndex((status) => status === "PLANNED");
  const previous = next > 0 ? statuses.slice(0, next).findLastIndex((status) => status === "PASSED") : -1;
  if (next > 0 && previous >= 0) {
    statuses[next] = "DRIVING";
    statuses[previous] = "DEPARTED";
  }
  return statuses;
}

export type TripPosition =
  | { state: "before" }
  | { state: "after" }
  | {
      state: "moving" | "atStop";
      latLng: LatLng;
      /** Last stop left and the next one (the same stop twice while standing there) */
      between: [string, string];
      /** Index into trip.stops of the next stop (or the stop it stands at) */
      nextIndex: number;
      /** Minutes until the next stop (until departure while standing) */
      minutesToNext: number;
    };

function interpolate(a: LatLng, b: LatLng, fraction: number): LatLng {
  const from = toRd(a.lng, a.lat);
  const to = toRd(b.lng, b.lat);
  const { lat, lng } = fromRd(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/** Where the vehicle is at `at`: between the last stop left and the next (planar in RD), at a stop, before its start or after its end; null without positions */
export function positionAt(trip: Trip, at: Date): TripPosition | null {
  const stops = trip.stops.map((stop, index) => ({ stop, index })).filter(({ stop }) => !stop.cancelled && stop.latLng && arrivalAt(stop));
  if (stops.length === 0) return null;
  const t = at.getTime();
  if (t < departAt(stops[0].stop)!.getTime()) return { state: "before" };
  const lastStop = stops[stops.length - 1].stop;
  if (t >= arrivalAt(lastStop)!.getTime()) return { state: "after" };
  for (let i = 0; i < stops.length; i++) {
    const { stop, index } = stops[i];
    const arrival = arrivalAt(stop)!.getTime();
    const departure = departAt(stop)!.getTime();
    if (i > 0 && t >= arrival && t < departure) return { state: "atStop", latLng: stop.latLng!, between: [stop.name, stop.name], nextIndex: index, minutesToNext: Math.max(0, Math.round((departure - t) / 60_000)) };
    const next = stops[i + 1];
    if (!next) break;
    const nextArrival = arrivalAt(next.stop)!.getTime();
    if (t >= departure && t < nextArrival) {
      const fraction = nextArrival === departure ? 1 : (t - departure) / (nextArrival - departure);
      return {
        state: "moving",
        latLng: interpolate(stop.latLng!, next.stop.latLng!, fraction),
        between: [stop.name, next.stop.name],
        nextIndex: next.index,
        minutesToNext: Math.max(0, Math.round((nextArrival - t) / 60_000)),
      };
    }
  }
  return null;
}

const shift = (date: Date | null, ms: number) => (date ? new Date(date.getTime() + ms) : null);

/** The same run `ms` earlier/later (an earlier bus of the same line, derived from the timetable interval) */
export function shiftTrip(trip: Trip, ms: number, journeyId: string): Trip {
  return {
    ...trip,
    journeyId,
    estimated: true,
    stops: trip.stops.map((stop) => ({ ...stop, plannedArr: shift(stop.plannedArr, ms), arr: shift(stop.arr, ms), plannedDep: shift(stop.plannedDep, ms), dep: shift(stop.dep, ms) })),
  };
}
