import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Hunt } from "../models/hunt.model";
import { closeScraper, jotihuntLogin, scrapeHunts } from "../services/jotihunt-scraper.service";
import { markSyncFailure, markSyncStart, markSyncSuccess } from "../services/hunt-sync-state";
import { linkScrapedHunts } from "../services/hunt-report-sync.service";
import { deadline } from "../services/http-limits";
import { assignSiteKeys, type ScrapedHunt } from "../services/jotihunt-hunts.parse";

/** A whole scrape (browser start, login, page load) may take this long; then the browser is closed and the run ends */
export const SCRAPE_DEADLINE_MS = 120_000;

/** A scraped hunt as stored (see Hunt) */
export interface StoredHunt {
  siteKey: string;
  area: string;
  huntCode: string | null;
  status: string;
  points: number;
  huntTime: Date | null;
  /** The time as the site shows it */
  huntTimeText: string;
  updatedAt: Date;
}

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

/** The scraped hunts as stored. */
export function toStoredHunts(scraped: ScrapedHunt[], now = new Date()): StoredHunt[] {
  return scraped.map((hunt) => ({
    siteKey: hunt.siteKey,
    area: hunt.area,
    huntCode: hunt.huntCode,
    status: hunt.statusText,
    points: hunt.points,
    huntTime: hunt.huntTime,
    huntTimeText: hunt.huntTimeText,
    updatedAt: now,
  }));
}

/**
 * Store the scraped hunts: upsert by siteKey (the code, else area + time), and drop hunts the website no longer lists
 * only when the answer looks complete. An empty list, or one less than half as long as what is stored (a broken or
 * half-loaded page), keeps every stored hunt.
 */
export async function storeHunts(hunts: StoredHunt[]): Promise<{ deleted: boolean }> {
  if (hunts.length === 0) return { deleted: false };
  await backfillSiteKeys();
  await Hunt.bulkWrite(hunts.map((hunt) => ({ updateOne: { filter: { siteKey: hunt.siteKey }, update: { $set: hunt }, upsert: true } })));
  const stored = await Hunt.countDocuments();
  if (hunts.length * 2 < stored) return { deleted: false };
  await Hunt.deleteMany({ siteKey: { $nin: hunts.map((hunt) => hunt.siteKey) } });
  return { deleted: true };
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

  let webHunts: ScrapedHunt[];
  try {
    webHunts = await deadline(scrapeHunts(), SCRAPE_DEADLINE_MS, `Scraping took longer than ${SCRAPE_DEADLINE_MS / 1000} s`);
  } catch (error) {
    markSyncFailure(error, new Date());
    // Start from a fresh browser next run; a broken page or login would otherwise keep failing
    await closeScraper();
    logger.error("(CRON) Scraping hunts failed:", error);
    return;
  }
  if (webHunts.length === 0) {
    markSyncSuccess(new Date());
    logger.debug("(CRON) The hunts table is empty; stored hunts are kept");
    return;
  }

  // Scraping is slow and not tracked; storing is, and only into the database the run started on
  await runTracked(
    async () => {
      await keepStoredDates(webHunts).catch((error) => logger.warn("(CRON) Could not look up stored hunt dates:", error));
      const hunts = toStoredHunts(webHunts);
      // Upsert by code (else area + time) and drop hunts the website no longer lists: /hunts is never briefly empty
      await storeHunts(hunts)
        .then(({ deleted }) => {
          markSyncSuccess(new Date());
          if (!deleted) logger.warn(`(CRON) Scraped only ${hunts.length} hunts, far fewer than stored; kept the stored hunts`);
        })
        .catch((error) => {
          markSyncFailure(error, new Date());
          logger.error("(CRON) Error storing hunts in database:", error);
        });

      // Copy status and points to the app's own reports; they keep them after the scraper forgets older hunts
      await linkScrapedHunts(webHunts.map((hunt) => ({ huntCode: hunt.huntCode, status: hunt.statusText, points: hunt.points, area: hunt.area, time: hunt.huntTime }))).catch((error) => {
        logger.error("(CRON) Error linking scraped hunts to hunt reports:", error);
      });
    },
    { generation },
  );
}
