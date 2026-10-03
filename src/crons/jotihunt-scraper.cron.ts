import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Hunt } from "../models/hunt.model";
import { closeScraper, scrapeHunts } from "../services/jotihunt-scraper.service";
import { linkScrapedHunts } from "../services/hunt-report-sync.service";
import { WebHunt } from "../types/api";

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
    webHunts = await scrapeHunts();
  } catch (error) {
    // Start from a fresh browser next run; a broken page or login would otherwise keep failing
    await closeScraper();
    throw error;
  }

  const hunts = webHunts.map((webHunt) => {
    return {
      area: webHunt.area,
      status: webHunt.status,
      huntCode: webHunt.huntCode,
      points: webHunt.points,
      huntTime: webHunt.huntTime,
      updatedAt: new Date(),
    };
  });

  // Scraping is slow and not tracked; storing is, and only into the database the run started on
  await runTracked(
    async () => {
      // Upsert by hunt code and drop hunts the website no longer lists: /hunts is never briefly empty
      await Hunt.bulkWrite(hunts.map((hunt) => ({ updateOne: { filter: { huntCode: hunt.huntCode }, update: { $set: hunt as Record<string, unknown> }, upsert: true } })))
        .then(() => Hunt.deleteMany({ huntCode: { $nin: hunts.map((hunt) => hunt.huntCode) } }))
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
