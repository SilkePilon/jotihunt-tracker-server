import type { Types } from "mongoose";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent } from "../models/hunt-sync-event.model";
import { isArchiveShown } from "../editions/work-tracking";
import { syncStateView } from "./hunt-sync-state";
import { classifyStatus, type HuntStatusClass } from "./jotihunt-hunts.parse";
import type { HuntSyncEventType } from "./hunt-sync-diff";

export interface HuntLocationView {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Estimated from our own trackers (jotihunt.nl never shows the location) */
  estimated: boolean;
  /** The tracker an estimate came from */
  source: string | null;
}

/** GET /hunts: a hunt as synced from jotihunt.nl */
export interface SyncedHuntView {
  _id: string;
  siteKey: string;
  area: string;
  huntTime: string | null;
  status: HuntStatusClass;
  statusText: string;
  points: number;
  qrCode: string | null;
  location: HuntLocationView | null;
  firstSeenAt: string;
  statusChangedAt: string | null;
}

/** GET /hunts/sync */
export interface HuntSyncStatusView {
  configured: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Unknown statuses count as pending (not judged yet) */
  counts: { approved: number; pending: number; rejected: number; total: number };
  /** Sum of the points of all synced hunts */
  points: number;
}

/** GET /hunts/events: one line of the sync log */
export interface HuntSyncEventView {
  _id: string;
  huntId: string;
  area: string;
  type: HuntSyncEventType;
  points: number | null;
  at: string;
  huntTime: string | null;
  location: HuntLocationView | null;
}

interface StoredLocation {
  lat: number;
  lng: number;
  accuracy?: number | null;
  estimated?: boolean | null;
  source?: string | null;
}

interface StoredHunt {
  _id: Types.ObjectId;
  siteKey?: string | null;
  area: string;
  huntTime?: Date | null;
  status: string;
  statusClass?: string | null;
  statusText?: string | null;
  points: number;
  qrCode?: string | null;
  location?: StoredLocation | null;
  firstSeenAt?: Date | null;
  statusChangedAt?: Date | null;
  updatedAt: Date;
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
/** Locations stored before the estimate existed have neither flag nor source */
const locationView = (location: StoredLocation | null | undefined): HuntLocationView | null =>
  location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy ?? null, estimated: location.estimated ?? false, source: location.source ?? null } : null;

/** Status class of a stored hunt; hunts stored before 17 Oct 2026 have only the site's text */
export function statusClassOf(hunt: Pick<StoredHunt, "status" | "statusClass" | "points">): HuntStatusClass {
  const stored = hunt.statusClass;
  return stored === "pending" || stored === "approved" || stored === "rejected" || stored === "unknown" ? stored : classifyStatus(hunt.status, hunt.points);
}

export function toSyncedHuntView(hunt: StoredHunt): SyncedHuntView {
  return {
    _id: String(hunt._id),
    siteKey: hunt.siteKey ?? `legacy:${String(hunt._id)}`,
    area: hunt.area.toLowerCase(),
    huntTime: iso(hunt.huntTime),
    status: statusClassOf(hunt),
    statusText: hunt.statusText ?? hunt.status,
    points: hunt.points,
    qrCode: hunt.qrCode ?? null,
    location: locationView(hunt.location),
    firstSeenAt: (hunt.firstSeenAt ?? hunt.updatedAt).toISOString(),
    statusChangedAt: iso(hunt.statusChangedAt),
  };
}

/** Newest hunt first (by hunt time, then first seen) */
export async function listSyncedHunts(): Promise<SyncedHuntView[]> {
  const hunts = (await Hunt.find().lean()) as StoredHunt[];
  const time = (hunt: StoredHunt) => (hunt.huntTime ?? hunt.firstSeenAt ?? hunt.updatedAt).getTime();
  return hunts.sort((a, b) => time(b) - time(a)).map(toSyncedHuntView);
}

export async function huntSyncStatus(): Promise<HuntSyncStatusView> {
  const hunts = (await Hunt.find().select("status statusClass points").lean()) as Pick<StoredHunt, "status" | "statusClass" | "points">[];
  const counts = { approved: 0, pending: 0, rejected: 0, total: hunts.length };
  let points = 0;
  for (const hunt of hunts) {
    const status = statusClassOf(hunt);
    if (status === "approved") counts.approved++;
    else if (status === "rejected") counts.rejected++;
    else counts.pending++;
    points += Number.isFinite(hunt.points) ? hunt.points : 0;
  }
  // An archive is never scraped: no sync times (the client then shows its hunts and points without a "x s geleden")
  const state = isArchiveShown() ? { configured: true, running: false, lastSuccessAt: null, lastAttemptAt: null, lastError: null } : syncStateView();
  return { ...state, counts, points };
}

export const MAX_EVENTS_PAGE = 200;

/** Sync log entries newest first, before `before` when given; location and time from the hunt when it still exists */
export async function listHuntSyncEvents(options: { limit?: number; before?: Date | null } = {}): Promise<HuntSyncEventView[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), MAX_EVENTS_PAGE);
  const events = await HuntSyncEvent.find(options.before ? { at: { $lt: options.before } } : {})
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .lean();
  const hunts = (await Hunt.find({ _id: { $in: [...new Set(events.map((event) => String(event.huntId)))] } })
    .select("huntTime location")
    .lean()) as Pick<StoredHunt, "_id" | "huntTime" | "location">[];
  const byId = new Map(hunts.map((hunt) => [String(hunt._id), hunt]));
  return events.map((event) => {
    const hunt = byId.get(String(event.huntId));
    return {
      _id: String(event._id),
      huntId: String(event.huntId),
      area: event.area,
      type: event.type as HuntSyncEventType,
      points: event.points ?? null,
      at: event.at.toISOString(),
      huntTime: iso(hunt?.huntTime ?? event.huntTime),
      location: locationView(hunt?.location ?? event.location),
    };
  });
}
