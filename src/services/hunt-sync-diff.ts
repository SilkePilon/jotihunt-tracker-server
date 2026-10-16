import type { HuntStatusClass, ScrapedHunt } from "./jotihunt-hunts.parse";

export type HuntSyncEventType = "new" | "approved" | "rejected" | "points";
export const HUNT_SYNC_EVENT_TYPES: readonly HuntSyncEventType[] = ["new", "approved", "rejected", "points"];

/** A stored hunt as far as the diff needs it */
export interface StoredHuntLike {
  siteKey: string;
  statusClass: HuntStatusClass | string;
  points: number;
}

/** A sync log entry before it is stored */
export interface EventDraft {
  siteKey: string;
  area: string;
  type: HuntSyncEventType;
  /** Points for approved / points events */
  points: number | null;
  at: Date;
}

/**
 * The first store into an empty database with more than one hunt (a fresh server, a wiped database): those hunts are
 * not news, so only "new" entries are logged and nobody gets a push.
 */
export function isInitialImport(storedCount: number, scrapedCount: number): boolean {
  return storedCount === 0 && scrapedCount > 1;
}

/**
 * What changed between the stored and the scraped hunts, in page order:
 * - a new siteKey → "new" (and "approved" / "rejected" when it is already judged, except on an initial import);
 * - a status class change to approved or rejected → that event;
 * - other points while it stays approved → "points".
 * Hunts that disappear are no event.
 */
export function diffHunts(previous: StoredHuntLike[], next: ScrapedHunt[], now: Date, options: { initial?: boolean } = {}): EventDraft[] {
  const before = new Map(previous.map((hunt) => [hunt.siteKey, hunt]));
  const events: EventDraft[] = [];
  const add = (hunt: ScrapedHunt, type: HuntSyncEventType, points: number | null) => events.push({ siteKey: hunt.siteKey, area: hunt.area, type, points, at: now });
  const outcome = (hunt: ScrapedHunt) => {
    if (hunt.status === "approved") add(hunt, "approved", hunt.points);
    else if (hunt.status === "rejected") add(hunt, "rejected", null);
  };

  for (const hunt of next) {
    const old = before.get(hunt.siteKey);
    if (!old) {
      add(hunt, "new", null);
      if (!options.initial) outcome(hunt);
      continue;
    }
    if (old.statusClass !== hunt.status) outcome(hunt);
    else if (hunt.status === "approved" && old.points !== hunt.points) add(hunt, "points", hunt.points);
  }
  return events;
}
