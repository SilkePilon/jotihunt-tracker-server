import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Article } from "../models/article.model";
import { getArticlesPage, JotihuntPausedError, type ArticlesPage } from "../services/jotihunt.service";
import { syncArticles } from "../services/article-sync.service";
import { ApiArticle } from "../types/api";

/** Pages fetched at most per run (15 articles each); 2025 had 61 articles by Saturday evening */
export const MAX_ARTICLE_PAGES = 5;

/**
 * Page 1 (newest first) and, while a full page holds only unseen articles, the next pages: after an outage (or on the
 * first run) more than 15 new articles must not be lost. Stops at MAX_ARTICLE_PAGES. A failing later page keeps the
 * pages already fetched; a failing page 1 throws.
 */
export async function fetchNewArticles(fetchPage: (page: number) => Promise<ArticlesPage> = getArticlesPage, isKnown = knownArticleIds): Promise<ApiArticle[]> {
  const articles: ApiArticle[] = [];
  for (let page = 1; page <= MAX_ARTICLE_PAGES; page++) {
    let result: ArticlesPage;
    try {
      result = await fetchPage(page);
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    articles.push(...result.articles);
    if (page >= result.lastPage || result.articles.length < result.perPage) break;
    const known = await isKnown(result.articles.map((article) => article.id));
    if (known.size > 0) break;
  }
  return articles;
}

async function knownArticleIds(ids: unknown[]): Promise<Set<number>> {
  const numbers = ids.filter((id): id is number => typeof id === "number");
  const known = await Article.find({ id: { $in: numbers } }, { id: 1 }).lean();
  return new Set(known.map((article) => article.id));
}

export default async function retrieveJotihuntArticles() {
  if (skipInDemoMode("jotihunt-articles", (message) => logger.debug(message))) return;

  logger.debug("(CRON) Retrieving Jotihunt articles from API...");

  const generation = currentGeneration();
  let apiArticles: ApiArticle[];
  try {
    apiArticles = await fetchNewArticles();
  } catch (error) {
    // Logged by the service (one line); a pause after errors/429 is expected and quiet
    if (error instanceof JotihuntPausedError) logger.debug(`(CRON) Articles skipped: ${error.message}`);
    else if (!(error instanceof Error && error.name === "JotihuntApiError")) logger.error(`(CRON) Error retrieving articles: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
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
