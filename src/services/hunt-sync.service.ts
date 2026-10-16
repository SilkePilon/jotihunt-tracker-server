import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { AppNotification, type AppNotificationDocument } from "../models/notification.model";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { buildHuntSyncNotification, type HuntSyncNotificationEvent } from "./notifier.helpers";
import { sendToAll } from "./push.service";

/** Markers made from synced hunts carry this source and the hunt's siteKey as externalId */
export const HUNT_MARKER_SOURCE = "jotihunt";

/**
 * Make the hunt markers match the synced hunts: one marker (type hunt) per hunt with a location, at that location, at
 * the hunt time (else when it was first seen); moved when the location or time changes, removed when the hunt is gone.
 * Only writes what changed (every marker write clears the cached GET /markers).
 */
export async function syncHuntMarkers(): Promise<{ created: number; updated: number; deleted: number }> {
  const [hunts, markers] = await Promise.all([
    Hunt.find({ location: { $ne: null }, siteKey: { $type: "string" } })
      .select("siteKey area huntTime firstSeenAt updatedAt location")
      .lean(),
    Marker.find({ source: HUNT_MARKER_SOURCE }).lean(),
  ]);
  const existing = new Map(markers.map((marker) => [marker.externalId ?? "", marker]));
  const wanted = new Set<string>();
  let created = 0;
  let updated = 0;
  for (const hunt of hunts) {
    if (!hunt.location || !hunt.siteKey) continue;
    wanted.add(hunt.siteKey);
    const time = hunt.huntTime ?? hunt.firstSeenAt ?? hunt.updatedAt;
    const coordinates = [hunt.location.lng, hunt.location.lat];
    const area = hunt.area.toLowerCase();
    const marker = existing.get(hunt.siteKey);
    if (!marker) {
      await Marker.create({ area, time, type: MarkerType.Hunt, location: { type: "Point", coordinates }, source: HUNT_MARKER_SOURCE, externalId: hunt.siteKey });
      created++;
      continue;
    }
    const same = marker.area === area && marker.time.getTime() === time.getTime() && marker.location.coordinates[0] === coordinates[0] && marker.location.coordinates[1] === coordinates[1];
    if (same) continue;
    await Marker.updateOne({ _id: marker._id }, { $set: { area, time, location: { type: "Point", coordinates } } });
    updated++;
  }
  const gone = markers.filter((marker) => !wanted.has(marker.externalId ?? "")).map((marker) => marker._id);
  if (gone.length > 0) await Marker.deleteMany({ _id: { $in: gone } });
  return { created, updated, deleted: gone.length };
}

/** A "new" hunt whose hunt time is older than this is no news (a re-import), only its log line is kept */
export const STALE_NEW_HUNT_MS = 2 * 60 * 60 * 1000;

/**
 * Store and push a notification per sync event: hunt in, approved, rejected. Nothing for an initial import, for
 * "points" changes, or for a "new" hunt that is hours old. Pushes are tracked like the notifier's.
 */
export async function notifyHuntEvents(
  result: { events: HuntSyncNotificationEvent[]; initial: boolean },
  options: { now?: Date; send?: (notification: AppNotificationDocument) => Promise<unknown> } = {},
): Promise<AppNotificationDocument[]> {
  if (result.initial) return [];
  const now = options.now ?? new Date();
  const inputs = result.events.flatMap((event) => {
    if (event.initial) return [];
    if (event.type === "new" && event.huntTime && now.getTime() - event.huntTime.getTime() > STALE_NEW_HUNT_MS) return [];
    const input = buildHuntSyncNotification(event);
    return input ? [input] : [];
  });
  if (inputs.length === 0) return [];
  const created = await AppNotification.insertMany(inputs.map((input) => ({ ...input, createdAt: new Date() })));
  const send = options.send ?? ((notification: AppNotificationDocument) => sendToAll(notification));
  const generation = currentGeneration();
  for (const notification of created) void runTracked(() => Promise.resolve(send(notification)), { generation }).catch(() => undefined);
  return created;
}
