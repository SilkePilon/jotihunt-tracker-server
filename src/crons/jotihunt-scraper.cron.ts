import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Hunt } from "../models/hunt.model";
import { login, scrapeHunts } from "../services/jotihunt.service";
import { linkScrapedHunts } from "../services/hunt-report-sync.service";
import { Page } from "puppeteer";

export default async function scrapeJotihuntWebsite() {
  if (skipInDemoMode("jotihunt-scraper", (message) => logger.debug(message))) return;

  logger.info("(CRON) Scraping required data from Jotihunt website...");

  let page: Page | undefined;
  const generation = currentGeneration();

  try {
    const currentPage = await login();
    page = currentPage;

    const webHunts = await scrapeHunts(currentPage);
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
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
      await page.browser().close().catch(() => undefined);
    }
  }
}
