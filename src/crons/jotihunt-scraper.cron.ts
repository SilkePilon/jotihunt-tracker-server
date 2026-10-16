import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent, type HuntSyncEventDoc } from "../models/hunt-sync-event.model";
import { closeScraper, jotihuntLogin, scrapeHunts } from "../services/jotihunt-scraper.service";
import { markSyncFailure, markSyncSettled, markSyncStart, markSyncSuccess } from "../services/hunt-sync-state";
import { diffHunts, isInitialImport } from "../services/hunt-sync-diff";
import { deadline } from "../services/http-limits";
import { assignSiteKeys, classifyStatus, type ScrapedHunt } from "../services/jotihunt-hunts.parse";

/** A whole scrape (browser start, login, page load) may take this long; then the browser is closed and the run ends */
export const SCRAPE_DEADLINE_MS = 120_000;

/** Hunts stored before siteKey existed get the key of their code (once; afterwards nothing matches). */
async function backfillSiteKeys() {
  await Hunt.updateMany({ siteKey: { $exists: false }, huntCode: { $type: "string" } }, [{ $set: { siteKey: { $concat: ["code:", { $trim: { input: "$huntCode" } }] } } }], { updatePipeline: true });
}

const CLOCK_ONLY = /^\d{1,2}[:.]\d{2}(?::\d{2})?$/;

/**
 * A time the site shows as a clock only ("09:15") is dated to its most recent occurrence, so on Sunday a Saturday
 * 09:15 would become Sunday 09:15. Rows already stored (same area, same text) keep their stored date. Mutates `time`.
 */
export async function keepStoredDates(scraped: ScrapedHunt[]): Promise<void> {
  const clockOnly = scraped.filter((hunt) => CLOCK_ONLY.test(hunt.huntTimeText.trim()));
  if (clockOnly.length === 0) return;
  const stored = await Hunt.find({ huntTimeText: { $in: [...new Set(clockOnly.map((hunt) => hunt.huntTimeText.trim()))] }, huntTime: { $type: "date" } })
    .select("area huntTimeText huntTime")
    .sort({ huntTime: -1 })
    .lean();
  for (const hunt of clockOnly) {
    const match = stored.find((entry) => entry.area.toLowerCase() === hunt.area.toLowerCase() && entry.huntTimeText === hunt.huntTimeText.trim());
    if (match?.huntTime) hunt.huntTime = match.huntTime;
  }
  // A re-dated time changes a time-based key
  assignSiteKeys(scraped);
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

/**
 * Store the scraped hunts and log what changed (HuntSyncEvent):
 * - upsert by siteKey; a location is never cleared by a scrape that found none;
 * - drop hunts the website no longer lists, but only inside the time window the page shows (hunts older than its
 *   oldest row may simply have scrolled off a "last N hunts" list and are kept as history), and only when the answer
 *   looks complete: an empty list, or one less than half as long as what is stored in that window (a broken or
 *   half-loaded page), keeps every stored hunt.
 */
export async function storeHunts(scraped: ScrapedHunt[], now = new Date()): Promise<StoreResult> {
  if (scraped.length === 0) return { deleted: false, events: [], initial: false, removed: [] };
  await backfillSiteKeys();
  const keys = scraped.map((hunt) => hunt.siteKey);
  const storedCount = await Hunt.countDocuments();
  const previous = (await Hunt.find({ siteKey: { $in: keys } }).select("siteKey status statusClass points").lean()).map((hunt) => ({
    siteKey: hunt.siteKey!,
    statusClass: hunt.statusClass ?? classifyStatus(hunt.status, hunt.points),
    points: hunt.points,
  }));
  const initial = isInitialImport(storedCount, scraped.length);
  const drafts = diffHunts(previous, scraped, now, { initial });
  const before = new Map(previous.map((hunt) => [hunt.siteKey, hunt]));

  await Hunt.bulkWrite(
    scraped.map((hunt) => {
      const old = before.get(hunt.siteKey);
      const judged = hunt.status === "approved" || hunt.status === "rejected";
      return {
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
              ...(hunt.qrCode && { qrCode: hunt.qrCode }),
              ...(hunt.location && { location: hunt.location }),
              ...(old && old.statusClass !== hunt.status && { statusChangedAt: now }),
            },
            $setOnInsert: { firstSeenAt: now, ...(!old && { statusChangedAt: judged ? now : null }) },
          },
          upsert: true,
        },
      };
    }),
  );

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

  // Only hunts inside the page's time window can be missing for real
  const times = scraped.flatMap((hunt) => (hunt.huntTime ? [hunt.huntTime.getTime()] : []));
  const windowFilter = times.length === scraped.length ? { $or: [{ huntTime: { $gte: new Date(Math.min(...times)) } }, { huntTime: null }] } : {};
  const inWindow = await Hunt.countDocuments(windowFilter);
  if (scraped.length * 2 < inWindow) return { deleted: false, events, initial, removed: [] };
  const gone = await Hunt.find({ ...windowFilter, siteKey: { $nin: keys } })
    .select("siteKey")
    .lean();
  if (gone.length > 0) await Hunt.deleteMany({ _id: { $in: gone.map((hunt) => hunt._id) } });
  return { deleted: true, events, initial, removed: gone.flatMap((hunt) => (hunt.siteKey ? [hunt.siteKey] : [])) };
}

export default async function scrapeJotihuntWebsite() {
  if (skipInDemoMode("jotihunt-scraper", (message) => logger.debug(message))) {
    // No need to keep Chromium around while demo mode is on
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
  try {
    scraped = await deadline(scrapeHunts(), SCRAPE_DEADLINE_MS, `Scraping took longer than ${SCRAPE_DEADLINE_MS / 1000} s`);
  } catch (error) {
    markSyncFailure(error, new Date());
    // Start from a fresh browser next run; a broken page or login would otherwise keep failing
    await closeScraper();
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
        await keepStoredDates(scraped).catch((error) => logger.warn("(CRON) Could not look up stored hunt dates:", error));
        const result = await storeHunts(scraped);
        if (!result.deleted) logger.warn(`(CRON) Scraped only ${scraped.length} hunts, far fewer than stored; kept the stored hunts`);
        markSyncSuccess(new Date());
      },
      { generation },
    );
  } catch (error) {
    markSyncFailure(error, new Date());
    logger.error("(CRON) Error storing hunts in database:", error);
  } finally {
    // A demo switch skips the store: never leave the card spinning
    markSyncSettled();
  }
}
