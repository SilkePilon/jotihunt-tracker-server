import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { getArticles } from "../services/jotihunt.service";
import { syncArticles } from "../services/article-sync.service";

export default async function retrieveJotihuntArticles() {
  if (skipInDemoMode("jotihunt-articles", (message) => logger.debug(message))) return;

  logger.debug("(CRON) Retrieving Jotihunt articles from API...");

  const generation = currentGeneration();
  const apiArticles = await getArticles();
  // Store only into the database the run started on (skipped when a demo switch happened meanwhile)
  const result = await runTracked(() => syncArticles(apiArticles), { generation });
  if (!result) return;

  logger.debug(`(CRON) Synced ${result.upserted} articles, created ${result.cellsCreated} hint cells`);
  if (result.changedHints.length) {
    logger.warn(`(CRON) Hint articles changed after publication: ${result.changedHints.join(", ")}`);
  }
  if (result.failed.length) {
    logger.warn(`(CRON) Failed to sync articles: ${result.failed.join(", ")}`);
  }
}
