import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Hunt } from "../models/hunt.model";
import { closeScraper, scrapeHunts } from "../services/jotihunt-scraper.service";
import { linkScrapedHunts } from "../services/hunt-report-sync.service";
import { deadline } from "../services/http-limits";
import { siteKeyOf } from "../services/jotihunt-hunts.parse";
import { WebHunt } from "../types/api";

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
export async function keepStoredDates(webHunts: WebHunt[]): Promise<void> {
  const clockOnly = webHunts.filter((hunt) => CLOCK_ONLY.test(hunt.huntTime.trim()));
  if (clockOnly.length === 0) return;
  const stored = await Hunt.find({ huntTimeText: { $in: [...new Set(clockOnly.map((hunt) => hunt.huntTime.trim()))] }, huntTime: { $type: "date" } })
    .select("area huntTimeText huntTime")
    .sort({ huntTime: -1 })
    .lean();
  for (const hunt of clockOnly) {
    const match = stored.find((entry) => entry.area.toLowerCase() === hunt.area.toLowerCase() && entry.huntTimeText === hunt.huntTime.trim());
    if (match?.huntTime) hunt.time = match.huntTime;
  }
}

/** The scraped hunts with their store key; a key seen twice in one scrape (same fox, same minute, no code) gets a suffix. */
export function toStoredHunts(webHunts: WebHunt[], now = new Date()): StoredHunt[] {
  const seen = new Map<string, number>();
  return webHunts.map((webHunt) => {
    const key = siteKeyOf(webHunt);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return {
      siteKey: count === 1 ? key : `${key}#${count}`,
      area: webHunt.area,
      huntCode: webHunt.huntCode,
      status: webHunt.status,
      points: webHunt.points,
      huntTime: webHunt.time,
      huntTimeText: webHunt.huntTime.trim(),
      updatedAt: now,
    };
  });
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

  logger.debug("(CRON) Scraping required data from Jotihunt website...");
  const generation = currentGeneration();

  let webHunts: WebHunt[];
  try {
    webHunts = await deadline(scrapeHunts(), SCRAPE_DEADLINE_MS, `Scraping took longer than ${SCRAPE_DEADLINE_MS / 1000} s`);
  } catch (error) {
    // Start from a fresh browser next run; a broken page or login would otherwise keep failing
    await closeScraper();
    logger.error("(CRON) Scraping hunts failed:", error);
    return;
  }
  if (webHunts.length === 0) {
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
          if (!deleted) logger.warn(`(CRON) Scraped only ${hunts.length} hunts, far fewer than stored; kept the stored hunts`);
        })
        .catch((error) => {
          logger.error("(CRON) Error storing hunts in database:", error);
        });

      // Copy status and points to the app's own reports; they keep them after the scraper forgets older hunts
      await linkScrapedHunts(webHunts).catch((error) => {
        logger.error("(CRON) Error linking scraped hunts to hunt reports:", error);
      });
    },
    { generation },
  );
}
