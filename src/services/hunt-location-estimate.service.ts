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

export interface EstimateSources {
  /** Our trackers' fixes between `from` and `to` (skips sources that are not configured) */
  loadTracks(from: Date, to: Date, time: Date): Promise<TrackerTrack[]>;
  loadGroups(): Promise<AreaGroup[]>;
}

/** Traccar position history per device; none when Traccar is not configured. A failing device is skipped. */
async function traccarTracks(from: Date, to: Date): Promise<TrackerTrack[]> {
  if (!traccar.isTraccarConfigured) return [];
  const devices = await traccar.getDevices();
  const tracks = await Promise.all(
    devices
      .filter((device) => !device.disabled)
      .map(async (device) => {
        const positions = await traccar.getPositionHistory(device.id, from, to).catch(() => []);
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
  return tracks.filter((track) => track.fixes.length > 0);
}

/**
 * Life360 members' current fixes (memory only, no request to Life360): there is no history, so only useful while the
 * hunt is fresh; estimateHuntLocation drops fixes more than 10 min from the hunt time.
 */
function life360Tracks(time: Date): TrackerTrack[] {
  const members = getLife360Service()?.members().members ?? [];
  return members.flatMap((member) => {
    const location = member.location;
    if (!location) return [];
    const at = new Date(location.at);
    if (Math.abs(at.getTime() - time.getTime()) > MAX_FIX_GAP_MS) return [];
    return [{ name: member.name, fixes: [{ lat: location.lat, lng: location.lon, at, accuracy: location.accuracyM, speedKmh: location.speedKmh }] }];
  });
}

const defaultSources: EstimateSources = {
  loadTracks: async (from, to, time) => {
    const fromTraccar = await traccarTracks(from, to).catch((error) => {
      logger.warn(`(HUNTS) No Traccar positions for the hunt location estimate: ${describeHttpError(error)}`);
      return [];
    });
    return [...fromTraccar, ...life360Tracks(time)];
  },
  loadGroups,
};

/** When each hunt (by id) was last tried; entries go once the hunt is past giving up */
const lastTried = new Map<string, Date>();

/**
 * Give recent hunts without a location an estimated one from our trackers (see estimateHuntLocation): hunts whose time
 * is within LOOKBACK_MS, tried at most once per minute until GIVE_UP_MS. A location from anywhere else is never
 * overwritten. The estimate also goes onto the hunt's sync log entries that have none. Returns how many hunts got one.
 */
export async function estimateHuntLocations(now = new Date(), sources: EstimateSources = defaultSources): Promise<number> {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const hunts = await Hunt.find({ location: null, $or: [{ huntTime: { $gte: since } }, { huntTime: null, firstSeenAt: { $gte: since } }] })
    .select("_id area huntTime firstSeenAt")
    .lean();
  for (const [id, at] of lastTried) if (now.getTime() - at.getTime() > LOOKBACK_MS) lastTried.delete(id);

  const due = hunts.flatMap((hunt) => {
    const time = huntReferenceTime(hunt);
    return time && shouldTryEstimate(time, now, lastTried.get(String(hunt._id)) ?? null) ? [{ hunt, time }] : [];
  });
  if (due.length === 0) return 0;

  const groups = await sources.loadGroups();
  let estimated = 0;
  for (const { hunt, time } of due) {
    lastTried.set(String(hunt._id), now);
    try {
      const tracks = await sources.loadTracks(new Date(time.getTime() - WINDOW_BEFORE_MS), new Date(time.getTime() + WINDOW_AFTER_MS), time);
      const location = estimateHuntLocation({ area: hunt.area, time, tracks, groups });
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
