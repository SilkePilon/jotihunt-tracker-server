import { logger } from "../logger";
import { currentGeneration, runTracked, skipWhenArchive } from "../editions/work-tracking";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent, type HuntSyncEventDoc } from "../models/hunt-sync-event.model";
import { closeScraper, jotihuntLogin, scrapeHunts } from "../services/jotihunt-scraper.service";
import { markSyncFailure, markSyncSettled, markSyncStart, markSyncSuccess } from "../services/hunt-sync-state";
import { diffHunts, isInitialImport, lastOutcomeOf, type Outcome } from "../services/hunt-sync-diff";
import { HUNT_MARKER_SOURCE } from "../services/hunt-sync.service";
import { Marker } from "../models/marker.model";
import { notifyHuntEvents, syncHuntMarkers } from "../services/hunt-sync.service";
import { ESTIMATE_DEADLINE_MS, estimateHuntLocations } from "../services/hunt-location-estimate.service";
import { deadline } from "../services/http-limits";
import { classifyStatus, rekeyTimeHunts, type ScrapedHunt } from "../services/jotihunt-hunts.parse";

/** A whole scrape (login + page load) may take this long; then the run ends */
export const SCRAPE_DEADLINE_MS = 120_000;

/**
 * Hunts stored before siteKey existed get the key of their code (once; afterwards nothing matches). Empty or blank
 * codes are skipped: they would all become "code:" and clash on the unique index.
 */
async function backfillSiteKeys() {
  const filter = { siteKey: { $exists: false }, huntCode: { $type: "string" as const, $regex: /\S/ } };
  // Checked first: a write (even one matching nothing) clears the cached hunt lists
  if (!(await Hunt.exists(filter))) return;
  await Hunt.updateMany(filter, [{ $set: { siteKey: { $concat: ["code:", { $trim: { input: "$huntCode" } }] } } }], { updatePipeline: true });
}

const CLOCK_ONLY = /^\d{1,2}[:.]\d{2}(?::\d{2})?$/;

/** A stored hunt's date is only reused for a clock-only time when its hunt time is this recent */
export const KEEP_DATE_MS = 18 * 60 * 60_000;

/**
 * A time the site shows as a clock only ("09:15") is dated to its most recent occurrence (Amsterdam), so on Sunday a
 * Saturday 09:15 would become Sunday 09:15. Rows already stored (same area, same text) keep their stored date, but only
 * when that hunt time is within the last 18 hours: an older one is another day's hunt, not this row. Mutates `time`.
 */
export async function keepStoredDates(scraped: ScrapedHunt[], now = new Date()): Promise<void> {
  const clockOnly = scraped.filter((hunt) => CLOCK_ONLY.test(hunt.huntTimeText.trim()));
  if (clockOnly.length === 0) return;
  const stored = await Hunt.find({ huntTimeText: { $in: [...new Set(clockOnly.map((hunt) => hunt.huntTimeText.trim()))] }, huntTime: { $gte: new Date(now.getTime() - KEEP_DATE_MS), $lte: now } })
    .select("area huntTimeText huntTime")
    .sort({ huntTime: -1 })
    .lean();
  for (const hunt of clockOnly) {
    const match = stored.find((entry) => entry.area.toLowerCase() === hunt.area.toLowerCase() && entry.huntTimeText === hunt.huntTimeText.trim());
    if (match?.huntTime) hunt.huntTime = match.huntTime;
  }
  // A re-dated time changes a time-based key (and only those)
  rekeyTimeHunts(scraped);
}

export interface StoreResult {
  /** Whether hunts the website no longer lists were dropped (false when the page looked incomplete) */
  deleted: boolean;
  /** Sync log entries written by this store, in page order */
  events: HuntSyncEventDoc[];
  /** The first import into an empty database (no push notifications) */
  initial: boolean;
  /** siteKeys of the hunts that were dropped */
  removed: string[];
}

interface StoredScrapeFields {
  area: string;
  huntCode?: string | null;
  status: string;
  statusText?: string | null;
  statusClass?: string | null;
  points: number;
  huntTime?: Date | null;
  huntTimeText?: string | null;
  lastNotifiedOutcome?: string | null;
  lastNotifiedPoints?: number | null;
}

/**
 * Whether storing `hunt` would leave the stored hunt exactly as it is: every field the upsert sets compared as stored
 * (a field the upsert would add, e.g. on an old document, counts as a change). A scraped location always writes.
 */
export function isUnchanged(stored: StoredScrapeFields, hunt: ScrapedHunt, last: { outcome: Outcome | null; points: number | null }): boolean {
  const sameTime = (a: Date | null | undefined, b: Date | null) => (a == null || b == null ? a === b : a.getTime() === b.getTime());
  return (
    !hunt.location &&
    stored.area === hunt.area &&
    stored.huntCode === hunt.huntCode &&
    stored.status === hunt.statusText &&
    stored.statusText === hunt.statusText &&
    stored.statusClass === hunt.status &&
    stored.points === hunt.points &&
    sameTime(stored.huntTime, hunt.huntTime) &&
    stored.huntTimeText === hunt.huntTimeText &&
    stored.lastNotifiedOutcome === last.outcome &&
    stored.lastNotifiedPoints === last.points
  );
}

/**
 * Store the scraped hunts and log what changed (HuntSyncEvent):
 * - upsert by siteKey; a location is never cleared by a scrape that found none;
 * - drop hunts the website no longer lists, but only inside the time window the page shows (hunts older than its
 *   oldest row may simply have scrolled off a "last N hunts" list and are kept as history), and only when the answer
 *   looks complete: an empty list, or one less than half as long as what is stored in that window (a broken or
 *   half-loaded page), keeps every stored hunt. So does a page with rows the parser skipped (`skipped`) or could not
 *   date (raw: keys): the hunt of such a row would look gone.
 */
export async function storeHunts(scraped: ScrapedHunt[], now = new Date(), options: { skipped?: number } = {}): Promise<StoreResult> {
  if (scraped.length === 0) return { deleted: false, events: [], initial: false, removed: [] };
  await backfillSiteKeys();
  const keys = scraped.map((hunt) => hunt.siteKey);
  const storedCount = await Hunt.countDocuments();
  await rekeyMovedHunts(scraped);
  const stored = await Hunt.find({ siteKey: { $in: keys } })
    .select("siteKey area huntCode status statusText statusClass points huntTime huntTimeText lastNotifiedOutcome lastNotifiedPoints")
    .lean();
  const storedByKey = new Map(stored.map((hunt) => [hunt.siteKey!, hunt]));
  const previous = stored.map((hunt) => ({
    siteKey: hunt.siteKey!,
    statusClass: hunt.statusClass ?? classifyStatus(hunt.status, hunt.points),
    points: hunt.points,
    ...(hunt.lastNotifiedOutcome !== undefined && { lastNotifiedOutcome: (hunt.lastNotifiedOutcome ?? null) as "approved" | "rejected" | null, lastNotifiedPoints: hunt.lastNotifiedPoints ?? null }),
  }));
  const initial = isInitialImport(storedCount, scraped.length);
  const drafts = diffHunts(previous, scraped, now, { initial });
  const before = new Map(previous.map((hunt) => [hunt.siteKey, hunt]));

  const writes = scraped.flatMap((hunt) => {
    const old = before.get(hunt.siteKey);
    const judged = hunt.status === "approved" || hunt.status === "rejected";
    // The outcome the log now shows for it: the new one when judged, else what was logged before
    const last = judged ? { outcome: hunt.status as Outcome, points: hunt.points } : old ? lastOutcomeOf(old) : { outcome: null, points: null };
    // Nothing new: no write, so updatedAt, the oplog and the cached hunt lists stay as they are
    const current = storedByKey.get(hunt.siteKey);
    if (current && isUnchanged(current, hunt, last)) return [];
    return [
      {
        updateOne: {
          filter: { siteKey: hunt.siteKey },
          update: {
            $set: {
              area: hunt.area,
              huntCode: hunt.huntCode,
              status: hunt.statusText,
              statusText: hunt.statusText,
              statusClass: hunt.status,
              points: hunt.points,
              huntTime: hunt.huntTime,
              huntTimeText: hunt.huntTimeText,
              updatedAt: now,
              lastNotifiedOutcome: last.outcome,
              lastNotifiedPoints: last.points,
              ...(hunt.location && { location: hunt.location }),
              ...(old && old.statusClass !== hunt.status && { statusChangedAt: now }),
            },
            $setOnInsert: { firstSeenAt: now, ...(!old && { statusChangedAt: judged ? now : null }) },
          },
          upsert: true,
        },
      },
    ];
  });
  if (writes.length > 0) await Hunt.bulkWrite(writes);

  let events: HuntSyncEventDoc[] = [];
  if (drafts.length > 0) {
    const hunts = await Hunt.find({ siteKey: { $in: [...new Set(drafts.map((draft) => draft.siteKey))] } })
      .select("_id siteKey huntTime location")
      .lean();
    const byKey = new Map(hunts.map((hunt) => [hunt.siteKey, hunt]));
    // One millisecond apart, in page order: the log pages by `at`, and "approved" sorts above its own "new"
    const documents = drafts.flatMap((draft, index) => {
      const hunt = byKey.get(draft.siteKey);
      return hunt ? [{ ...draft, at: new Date(draft.at.getTime() + index), huntId: hunt._id, huntTime: hunt.huntTime ?? null, location: hunt.location ?? null, initial }] : [];
    });
    events = (await HuntSyncEvent.insertMany(documents)).map((event) => event.toObject() as HuntSyncEventDoc);
  }

  // Only hunts inside the page's time window (from its oldest readable time) can be missing for real; hunts without a
  // time are never dropped, and a page without any readable time drops nothing
  const times = scraped.flatMap((hunt) => (hunt.huntTime ? [hunt.huntTime.getTime()] : []));
  const incomplete = (options.skipped ?? 0) > 0 || scraped.some((hunt) => hunt.siteKey.startsWith("raw:"));
  if (times.length === 0 || incomplete) return { deleted: false, events, initial, removed: [] };
  const windowFilter = { huntTime: { $gte: new Date(Math.min(...times)) } };
  const inWindow = await Hunt.countDocuments(windowFilter);
  if (scraped.length * 2 < inWindow) return { deleted: false, events, initial, removed: [] };
  const gone = await Hunt.find({ ...windowFilter, siteKey: { $nin: keys } })
    .select("siteKey")
    .lean();
  if (gone.length > 0) await Hunt.deleteMany({ _id: { $in: gone.map((hunt) => hunt._id) } });
  return { deleted: true, events, initial, removed: gone.flatMap((hunt) => (hunt.siteKey ? [hunt.siteKey] : [])) };
}

/** A hunt whose key changed (a hunt code now shown, an old time-based key) is the same fox within this of the same time */
export const REKEY_MATCH_MS = 60_000;

/**
 * Scraped hunts with a key that is not stored take over a stored hunt of the same fox whose hunt time is within a
 * minute and whose key the page no longer shows (closest first), so a changed key is no new hunt (no "new" entry, no
 * push). Its markers and log entries follow the new key.
 */
async function rekeyMovedHunts(scraped: ScrapedHunt[]): Promise<void> {
  const keys = scraped.map((hunt) => hunt.siteKey);
  const known = new Set((await Hunt.find({ siteKey: { $in: keys } }).select("siteKey").lean()).map((hunt) => hunt.siteKey));
  const unseen = scraped.filter((hunt) => !known.has(hunt.siteKey) && hunt.huntTime);
  if (unseen.length === 0) return;
  // Areas are compared case-insensitively below; the query only narrows by time
  const unseenTimes = unseen.map((hunt) => hunt.huntTime!.getTime());
  const near = { $gte: new Date(Math.min(...unseenTimes) - REKEY_MATCH_MS), $lte: new Date(Math.max(...unseenTimes) + REKEY_MATCH_MS) };
  const candidates = await Hunt.find({ siteKey: { $nin: keys }, huntTime: near })
    .select("_id siteKey area huntTime")
    .lean();
  const taken = new Set<string>();
  // Two different hunt codes are two hunts, however close in time
  const kind = (key: string | null | undefined) => key?.split(":")[0] ?? "";
  const distinct = (a: string | null | undefined, b: string) => kind(a) === kind(b) && kind(b) === "code";
  for (const hunt of unseen) {
    const match = candidates
      .filter(
        (candidate) =>
          !taken.has(String(candidate._id)) &&
          !distinct(candidate.siteKey, hunt.siteKey) &&
          candidate.area.toLowerCase() === hunt.area.toLowerCase() &&
          Math.abs(candidate.huntTime!.getTime() - hunt.huntTime!.getTime()) <= REKEY_MATCH_MS,
      )
      .sort((a, b) => Math.abs(a.huntTime!.getTime() - hunt.huntTime!.getTime()) - Math.abs(b.huntTime!.getTime() - hunt.huntTime!.getTime()))[0];
    if (!match) continue;
    taken.add(String(match._id));
    await Hunt.updateOne({ _id: match._id }, { $set: { siteKey: hunt.siteKey } });
    if (match.siteKey) {
      await Marker.updateMany({ source: HUNT_MARKER_SOURCE, externalId: match.siteKey }, { $set: { externalId: hunt.siteKey } });
      await HuntSyncEvent.updateMany({ huntId: match._id }, { $set: { siteKey: hunt.siteKey } });
    }
  }
}

/**
 * Everything after a scrape: store the hunts, estimate locations for recent hunts without one (from our trackers),
 * then make the hunt markers match and tell everyone what changed. `estimate` (and its deadline) is replaceable for
 * tests.
 */
export async function storeAndSync(scraped: ScrapedHunt[], options: { estimate?: (now: Date) => Promise<number>; skipped?: number; estimateDeadlineMs?: number } = {}): Promise<StoreResult> {
  const estimate = options.estimate ?? ((now: Date) => estimateHuntLocations(now));
  await keepStoredDates(scraped).catch((error) => logger.warn("(CRON) Could not look up stored hunt dates:", error));
  const result = await storeHunts(scraped, new Date(), { skipped: options.skipped });
  if (!result.deleted) logger.warn(`(CRON) Kept every stored hunt: the page showed ${scraped.length} hunt(s) (${options.skipped ?? 0} row(s) skipped), far fewer than stored, unreadable rows or no readable times`);
  markSyncSuccess(new Date());
  // jotihunt.nl shows no location: estimate it before the markers are made
  // With a deadline: slow trackers must not hold up the next scrape
  const estimateDeadline = options.estimateDeadlineMs ?? ESTIMATE_DEADLINE_MS;
  await deadline(estimate(new Date()), estimateDeadline, `Estimating hunt locations took longer than ${estimateDeadline / 1000} s`).catch((error) =>
    logger.error("(CRON) Error estimating hunt locations:", error),
  );
  // Hunt markers feed the map, cooldown and prediction; then tell everyone what changed
  await syncHuntMarkers().catch((error) => logger.error("(CRON) Error syncing hunt markers:", error));
  await notifyHuntEvents(result).catch((error) => logger.error("(CRON) Error sending hunt notifications:", error));
  return result;
}

/** A failure that means the session is no good: a failed login or an expired form (419) */
export const dropsSession = (error: unknown) => error instanceof Error && /login failed|\b419\b/i.test(error.message);

export default async function scrapeJotihuntWebsite() {
  if (skipWhenArchive("jotihunt-scraper", (message) => logger.debug(message))) {
    // No need to keep the website session while an archive is shown
    await closeScraper();
    return;
  }
  if (!jotihuntLogin()) {
    // Not linked (Beheer → Algemeen): nothing to sync; the sync card shows "Niet gekoppeld"
    await closeScraper();
    return;
  }

  logger.debug("(CRON) Scraping required data from Jotihunt website...");
  const generation = currentGeneration();
  markSyncStart(new Date());

  let scraped: ScrapedHunt[];
  let skipped: number;
  try {
    ({ hunts: scraped, skipped } = await deadline(scrapeHunts(), SCRAPE_DEADLINE_MS, `Scraping took longer than ${SCRAPE_DEADLINE_MS / 1000} s`));
  } catch (error) {
    markSyncFailure(error, new Date());
    // Only a broken login drops the session (a page error keeps it); a failed login waits before the next try, see
    // fetchPage
    if (dropsSession(error)) await closeScraper();
    logger.error("(CRON) Scraping hunts failed:", error);
    return;
  }
  if (scraped.length === 0) {
    markSyncSuccess(new Date());
    logger.debug("(CRON) No hunts on the page; stored hunts are kept");
    return;
  }

  // Scraping is slow and not tracked; storing is, and only into the database the run started on
  try {
    await runTracked(
      async () => {
        await storeAndSync(scraped, { skipped });
      },
      { generation },
    );
  } catch (error) {
    markSyncFailure(error, new Date());
    logger.error("(CRON) Error storing hunts in database:", error);
  } finally {
    // An edition switch skips the store: never leave the card spinning
    markSyncSettled();
  }
}
