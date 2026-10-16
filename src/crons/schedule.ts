import cron from "node-cron";
import { logger } from "../logger";
import { reportCronErrors } from "../sentry";
import { isPushConfigured } from "../services/push.service";
import summarizeArticles from "./article-summaries.cron";
import splitHints from "./hint-split.cron";
import retrieveJotihuntAreas from "./jotihunt-areas.cron";
import retrieveJotihuntArticles from "./jotihunt-articles.cron";
import retrieveJotihuntLogos from "./jotihunt-logos.cron";
import scrapeJotihuntWebsite from "./jotihunt-scraper.cron";
import recomputePredictions from "./prediction.cron";
import notify from "./notifier.cron";

/** Schedule the cron jobs whose configuration is present, and warn about the ones that are not. */
export function scheduleCrons() {
  cron.setLogger(logger);

  if (process.env.JOTIHUNT_API_URL) {
    cron.schedule("*/10 * * * * *", reportCronErrors("jotihunt-areas", retrieveJotihuntAreas), { name: "jotihunt-areas", noOverlap: true });
    cron.schedule("*/10 * * * * *", reportCronErrors("jotihunt-articles", retrieveJotihuntArticles), { name: "jotihunt-articles", noOverlap: true });
  } else {
    logger.warn("JOTIHUNT_API_URL is not set, skipping areas and articles cron jobs");
  }

  if (process.env.JOTIHUNT_WEB_URL && process.env.JOTIHUNT_WEB_USERNAME && process.env.JOTIHUNT_WEB_PASSWORD) {
    cron.schedule("0 * * * * *", reportCronErrors("jotihunt-scraper", scrapeJotihuntWebsite), { name: "jotihunt-scraper", noOverlap: true });
  } else {
    logger.warn("JOTIHUNT_WEB_URL/JOTIHUNT_WEB_USERNAME/JOTIHUNT_WEB_PASSWORD not set, skipping website scraper cron job");
  }

  // Group logos from the public jotihunt.nl/subscriptions page: at startup and every 6 hours
  void reportCronErrors("jotihunt-logos", retrieveJotihuntLogos)().catch((error) => logger.error("Could not retrieve group logos", error));
  cron.schedule("0 7 */6 * * *", reportCronErrors("jotihunt-logos", retrieveJotihuntLogos), { name: "jotihunt-logos", noOverlap: true });

  // Fox prediction (Gemini): recompute changed areas every minute (and every area at least every 10 minutes)
  cron.schedule("30 * * * * *", reportCronErrors("fox-prediction", recomputePredictions), { name: "fox-prediction", noOverlap: true });
  if (!process.env.ORS_API_KEY) {
    logger.warn("ORS_API_KEY not set, fox prediction uses straight-line walking times");
  }

  // Summaries of news and assignments (Gemini): one per run, also for demo articles
  cron.schedule("5,25,45 * * * * *", reportCronErrors("article-summaries", summarizeArticles), { name: "article-summaries", noOverlap: true });

  // AI hint split (Gemini): corrects the rule's per-area cells of one hint article per run
  cron.schedule("15,35,55 * * * * *", reportCronErrors("hint-split", splitHints), { name: "hint-split", noOverlap: true });

  // Notifications: fox status changes, new articles and hunt deadlines (push + in-app feed)
  cron.schedule("*/10 * * * * *", reportCronErrors("notifier", notify), { name: "notifier", noOverlap: true });
  if (!isPushConfigured(logger)) {
    logger.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set, push notifications are off (in-app alerts still work)");
  }
}
