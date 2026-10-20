import distance from "@turf/distance";
import { statusIntervals, type StatusEvent } from "../routes/trail-legs";

/** Only legs ending in this window count */
export const SPEED_WINDOW_MS = 6 * 3600_000;
/** Shorter legs are GPS/hint jitter */
export const MIN_LEG_MS = 10 * 60_000;
/** A leg with more red than this is a fox that stood still or moved freely, not walking */
export const MAX_RED_MS = 30 * 60_000;
export const MIN_KMH = 3;
export const MAX_KMH = 7;
export const DEFAULT_KMH = 5;
/** Straight distance → walked distance when there is no route */
export const STRAIGHT_FACTOR = 1.2;
/** Without a trail, faster than this was a car */
export const CAR_KMH = 8;
export const MIN_LEGS = 2;

export interface SpeedLeg { id: string; from: Date; to: Date; fromCoord: [number, number]; toCoord: [number, number] }
export interface TrailInfo { mode: "walk" | "car" | "extra"; distanceM: number | null }
export interface Speed { kmh: number; measured: boolean; legs: number }

function redMs(red: { from: Date; to: Date }[], from: Date, to: Date): number {
  let total = 0;
  for (const interval of red) total += Math.max(0, Math.min(interval.to.getTime(), to.getTime()) - Math.max(interval.from.getTime(), from.getTime()));
  return total;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The fox's walking speed: median km/h of its recent legs, leaving out short legs, legs with a long red period and car
 * moves (trails mode, or faster than CAR_KMH without a trail). Clamped to MIN_KMH-MAX_KMH; DEFAULT_KMH with too few legs.
 * @param trails routed trail info by leg id, or null when trails are off
 */
export function measureSpeed(legs: SpeedLeg[], trails: Map<string, TrailInfo> | null, events: StatusEvent[], now: Date): Speed {
  const red = statusIntervals(events, now).filter((interval) => interval.status === "red");
  const speeds: number[] = [];
  for (const leg of legs) {
    const elapsedMs = leg.to.getTime() - leg.from.getTime();
    if (leg.to.getTime() < now.getTime() - SPEED_WINDOW_MS || elapsedMs < MIN_LEG_MS) continue;
    if (redMs(red, leg.from, leg.to) > MAX_RED_MS) continue;
    const straightM = distance(leg.fromCoord, leg.toCoord, { units: "meters" }) * STRAIGHT_FACTOR;
    const trail = trails?.get(leg.id);
    if (trail && trail.mode !== "walk") continue;
    const kmh = ((trail?.distanceM ?? straightM) / 1000) / (elapsedMs / 3600_000);
    if (!trail && kmh > CAR_KMH) continue;
    speeds.push(kmh);
  }
  if (speeds.length < MIN_LEGS) return { kmh: DEFAULT_KMH, measured: false, legs: speeds.length };
  const kmh = Math.min(MAX_KMH, Math.max(MIN_KMH, median(speeds)));
  return { kmh: Math.round(kmh * 10) / 10, measured: true, legs: speeds.length };
}
