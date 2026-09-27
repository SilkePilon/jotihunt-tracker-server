import { logger } from "..";
import { getArticles } from "../services/jotihunt.service";
import { syncArticles } from "../services/article-sync.service";

export default async function retrieveJotihuntArticles() {
  logger.info("(CRON) Retrieving Jotihunt articles from API...");

  const apiArticles = await getArticles();
  const result = await syncArticles(apiArticles);

  logger.info(`(CRON) Synced ${result.upserted} articles, created ${result.cellsCreated} hint cells`);
  if (result.changedHints.length) {
    logger.warn(`(CRON) Hint articles changed after publication: ${result.changedHints.join(", ")}`);
  }
  if (result.failed.length) {
    logger.warn(`(CRON) Failed to sync articles: ${result.failed.join(", ")}`);
  }
}
