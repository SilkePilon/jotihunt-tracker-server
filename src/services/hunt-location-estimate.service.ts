import { logger } from "../logger";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent } from "../models/hunt-sync-event.model";
import { describeHttpError } from "./http-limits";
import { loadGroups } from "./intel-chat/data";
import type { AreaGroup } from "./intel-chat/geo";
import { getLife360Service } from "./life360.service";
import * as traccar from "./traccar.service";
import { estimateHuntLocation, huntReferenceTime, LOOKBACK_MS, MAX_FIX_GAP_MS, shouldTryEstimate, WINDOW_AFTER_MS, WINDOW_BEFORE_MS, type TrackerTrack } from "./hunt-location-estimate";

const KNOTS_TO_KMH = 1.852;

/** The whole estimate phase of a scrape may take this long (the scraper cron waits for it) */
export const ESTIMATE_DEADLINE_MS = 20_000;

export interface EstimateSources {
  /**
   * Our trackers' fixes between `from` and `to` (skips sources that are not configured), asked once per run for the
   * window around every due hunt
   */
  loadTracks(from: Date, to: Date): Promise<TrackerTrack[]>;
  loadGroups(): Promise<AreaGroup[]>;
}

/** Traccar position history per device; none when Traccar is not configured. A failing device is skipped (one warning per run). */
async function traccarTracks(from: Date, to: Date): Promise<TrackerTrack[]> {
  if (!traccar.isTraccarConfigured) return [];
  const devices = await traccar.getDevices();
  let failed = 0;
  let firstError: unknown = null;
  const tracks = await Promise.all(
    devices
      .filter((device) => !device.disabled)
      .map(async (device) => {
        const positions = await traccar.getPositionHistory(device.id, from, to).catch((error: unknown) => {
          failed++;
          firstError ??= error;
          return [];
        });
        const fixes = positions.map((position) => {
          const raw = position as unknown as { fixTime?: string; deviceTime?: string; serverTime?: string };
          return {
            lat: position.latitude,
            lng: position.longitude,
            at: new Date(raw.fixTime ?? raw.deviceTime ?? raw.serverTime ?? NaN),
            // Traccar sends 0 when the device gave none
            accuracy: position.accuracy > 0 ? position.accuracy : null,
            speedKmh: Number.isFinite(position.speed) ? position.speed * KNOTS_TO_KMH : null,
          };
        });
        return { name: device.name, fixes: fixes.filter((fix) => !Number.isNaN(fix.at.getTime())) };
      }),
  );
  if (failed > 0) logger.warn(`(HUNTS) No Traccar positions of ${failed} device(s) for the hunt location estimate: ${describeHttpError(firstError)}`);
  return tracks.filter((track) => track.fixes.length > 0);
}

/**
 * Life360 members' current fixes (memory only, no request to Life360): there is no history, so only useful while the
 * hunt is fresh (live: used within MAX_FIX_GAP_MS of the hunt time).
 */
function life360Tracks(): TrackerTrack[] {
  const members = getLife360Service()?.members().members ?? [];
  return members.flatMap((member) => {
    const location = member.location;
    if (!location) return [];
    return [{ name: member.name, live: true, fixes: [{ lat: location.lat, lng: location.lon, at: new Date(location.at), accuracy: location.accuracyM, speedKmh: location.speedKmh }] }];
  });
}

/** The fixes of one hunt's window: -10 … +5 min for history, ±MAX_FIX_GAP_MS for live positions */
function tracksAround(tracks: TrackerTrack[], time: Date): TrackerTrack[] {
  const t = time.getTime();
  return tracks.flatMap((track) => {
    const fixes = track.fixes.filter((fix) => {
      const at = fix.at.getTime();
      return track.live ? Math.abs(at - t) <= MAX_FIX_GAP_MS : at >= t - WINDOW_BEFORE_MS && at <= t + WINDOW_AFTER_MS;
    });
    return fixes.length > 0 ? [{ ...track, fixes }] : [];
  });
}

const defaultSources: EstimateSources = {
  loadTracks: async (from, to) => {
    const fromTraccar = await traccarTracks(from, to).catch((error) => {
      logger.warn(`(HUNTS) No Traccar positions for the hunt location estimate: ${describeHttpError(error)}`);
      return [];
    });
    return [...fromTraccar, ...life360Tracks()];
  },
  loadGroups,
};

/** When each hunt (by id) was last tried; entries go once the hunt is past giving up */
const lastTried = new Map<string, Date>();

/**
 * Give recent hunts without a location an estimated one from our trackers (see estimateHuntLocation): hunts whose time
 * is within LOOKBACK_MS, tried at most once per minute until GIVE_UP_MS. A location from anywhere else is never
 * overwritten. The estimate also goes onto the hunt's sync log entries that have none. The trackers are asked once per
 * run, for the window around all due hunts. Returns how many hunts got one.
 */
export async function estimateHuntLocations(now = new Date(), sources: EstimateSources = defaultSources): Promise<number> {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const hunts = await Hunt.find({ location: null, locationDismissed: { $ne: true }, $or: [{ huntTime: { $gte: since } }, { huntTime: null, firstSeenAt: { $gte: since } }] })
    .select("_id area huntTime firstSeenAt")
    .lean();
  for (const [id, at] of lastTried) if (now.getTime() - at.getTime() > LOOKBACK_MS) lastTried.delete(id);

  const due = hunts.flatMap((hunt) => {
    const time = huntReferenceTime(hunt);
    return time && shouldTryEstimate(time, now, lastTried.get(String(hunt._id)) ?? null) ? [{ hunt, time }] : [];
  });
  if (due.length === 0) return 0;

  for (const { hunt } of due) lastTried.set(String(hunt._id), now);
  const groups = await sources.loadGroups();
  const times = due.map(({ time }) => time.getTime());
  let tracks: TrackerTrack[];
  try {
    tracks = await sources.loadTracks(new Date(Math.min(...times) - WINDOW_BEFORE_MS), new Date(Math.max(...times) + WINDOW_AFTER_MS));
  } catch (error) {
    logger.warn(`(HUNTS) No tracker positions for the hunt location estimate: ${describeHttpError(error)}`);
    return 0;
  }
  let estimated = 0;
  for (const { hunt, time } of due) {
    try {
      const location = estimateHuntLocation({ area: hunt.area, time, tracks: tracksAround(tracks, time), groups });
      if (!location) continue;
      // Only while it still has none (a scrape may have stored one meanwhile)
      const { modifiedCount } = await Hunt.updateOne({ _id: hunt._id, location: null }, { $set: { location } });
      if (modifiedCount === 0) continue;
      await HuntSyncEvent.updateMany({ huntId: hunt._id, location: null }, { $set: { location } });
      estimated++;
      logger.info(`(HUNTS) Estimated the location of a hunt in ${hunt.area} from tracker ${location.source} (±${location.accuracy} m)`);
    } catch (error) {
      logger.warn(`(HUNTS) Could not estimate a hunt location: ${describeHttpError(error)}`);
    }
  }
  return estimated;
}

/** For tests */
export function forgetEstimateAttempts(): void {
  lastTried.clear();
}
