import { estimateArea, metresBetween, type AreaGroup } from "./intel-chat/geo";

/**
 * Where a hunt probably happened, from our own trackers. jotihunt.nl never shows the location of a QR hunt back to us,
 * so the server takes the position of our tracker (Traccar device or Life360 member) that was in the hunt's deelgebied
 * closest to the hunt time. Pure logic; the IO lives in hunt-location-estimate.service.
 */

/** Tracker positions are looked at from this long before the hunt time… */
export const WINDOW_BEFORE_MS = 10 * 60_000;
/** …until this long after it */
export const WINDOW_AFTER_MS = 5 * 60_000;
/** A fix further than this from the hunt time is no evidence */
export const MAX_FIX_GAP_MS = 10 * 60_000;
/** The estimate circle is at least this wide (metres): we don't know which hunter scanned */
export const MIN_ACCURACY_M = 150;
/** The distance a tracker moved in the window counts up to this much (metres) */
export const MAX_MOVED_M = 1000;
/** Hunts without a location are looked at when their time is within this… */
export const LOOKBACK_MS = 2 * 60 * 60_000;
/** …but given up once the hunt is this old (Traccar uploads can lag minutes, so a few retries matter) */
export const GIVE_UP_MS = 60 * 60_000;
/** A hunt is tried at most once per this */
export const RETRY_MS = 60_000;

export interface TrackFix {
  lat: number;
  lng: number;
  at: Date;
  /** Metres; null when unknown */
  accuracy: number | null;
  /** km/h; null when unknown */
  speedKmh: number | null;
}

/** One tracker's fixes around the hunt time (any order) */
export interface TrackerTrack {
  /** Device or member display name */
  name: string;
  fixes: TrackFix[];
  /** A current position only (Life360: no history), used while within MAX_FIX_GAP_MS of the hunt time */
  live?: boolean;
}

export interface EstimatedLocation {
  lat: number;
  lng: number;
  accuracy: number;
  estimated: true;
  /** The tracker the estimate came from */
  source: string;
}

/** The time a hunt is estimated for: its hunt time, else when the sync first saw it */
export function huntReferenceTime(hunt: { huntTime?: Date | null; firstSeenAt?: Date | null }): Date | null {
  return hunt.huntTime ?? hunt.firstSeenAt ?? null;
}

/** Whether to try a hunt now: not older than GIVE_UP_MS and not tried within RETRY_MS */
export function shouldTryEstimate(time: Date, now: Date, lastTriedAt: Date | null): boolean {
  if (now.getTime() - time.getTime() > GIVE_UP_MS) return false;
  return !lastTriedAt || now.getTime() - lastTriedAt.getTime() >= RETRY_MS;
}

/**
 * The estimate for a hunt in `area` at `time`, or null when none of our trackers was in that deelgebied around then
 * (never a guess outside the area).
 * - per tracker: the fix closest to the hunt time (at most MAX_FIX_GAP_MS away), kept when estimateArea puts it in
 *   the hunt's area;
 * - among those: the closest in time; on a tie the slowest (a hunter stands still at the fox; unknown speed last);
 * - accuracy = max(MIN_ACCURACY_M, the fix's accuracy, how far the tracker moved from that fix within the window
 *   (-10 … +5 min) capped at MAX_MOVED_M).
 */
export function estimateHuntLocation(input: { area: string; time: Date; tracks: TrackerTrack[]; groups: AreaGroup[] }): EstimatedLocation | null {
  const area = input.area.trim().toLowerCase();
  const t = input.time.getTime();
  const gap = (fix: TrackFix) => Math.abs(fix.at.getTime() - t);
  const candidates = input.tracks.flatMap((track) => {
    const usable = track.fixes.filter((fix) => Number.isFinite(fix.lat) && Number.isFinite(fix.lng) && gap(fix) <= MAX_FIX_GAP_MS);
    if (usable.length === 0) return [];
    const closest = usable.reduce((best, fix) => (gap(fix) < gap(best) ? fix : best));
    if (estimateArea(closest, input.groups).area?.toLowerCase() !== area) return [];
    const inWindow = track.fixes.filter((fix) => fix.at.getTime() >= t - WINDOW_BEFORE_MS && fix.at.getTime() <= t + WINDOW_AFTER_MS);
    const moved = Math.min(MAX_MOVED_M, Math.max(0, ...inWindow.map((fix) => metresBetween(closest, fix))));
    return [{ name: track.name, fix: closest, moved }];
  });
  if (candidates.length === 0) return null;
  const speed = (fix: TrackFix) => fix.speedKmh ?? Infinity;
  candidates.sort((a, b) => gap(a.fix) - gap(b.fix) || speed(a.fix) - speed(b.fix));
  const { name, fix, moved } = candidates[0];
  return { lat: fix.lat, lng: fix.lng, accuracy: Math.round(Math.max(MIN_ACCURACY_M, fix.accuracy ?? 0, moved)), estimated: true, source: name };
}
