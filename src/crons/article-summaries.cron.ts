import { logger } from "../logger";
import { currentGeneration, runTracked, skipWhenArchive } from "../editions/work-tracking";
import { aiAvailable, requireAiModel } from "../services/ai/model";
import { GeminiError } from "../services/ai/gemini-error";
import { createArticleSummarizer, createSummaryJob } from "../services/article-summary.service";

// Without a Gemini key there are no summaries; the page then shows the full text only.
// Built once (the job keeps its backoff); the model is read per article, so a key or model set in Beheer applies at once
const job = createSummaryJob({
  summarizer: { summarize: (article) => createArticleSummarizer({ model: requireAiModel("summary") }).summarize(article) },
  // Only into the database the run started on (skipped when an edition switch happened meanwhile)
  beginRun: () => {
    const generation = currentGeneration();
    return (fn) => runTracked(fn, { generation });
  },
});

/**
 * A GeminiError carries our own message. Every error of an AI call is wrapped in one (the raw API error holds the
 * request, with the key), so any other error comes from MongoDB and its message is safe to log.
 */
function describe(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "unknown error";
}

/** Summarise new or changed news and assignment articles (one per run) */
export default async function summarizeArticles() {
  if (skipWhenArchive("article-summaries", (message) => logger.debug(message))) return;
  if (!aiAvailable()) return;
  const { done, failed } = await job.run();
  if (done.length > 0) logger.info(`(CRON) Summarised articles ${done.join(", ")}`);
  for (const failure of failed) {
    // A Gemini failure (rate limit, quota, bad answer) is expected and stays a warning; anything else is a bug and an issue
    if (failure.error instanceof GeminiError || !(failure.error instanceof Error)) logger.warn(`(CRON) Summary of article ${failure.id} failed: ${describe(failure.error)}`);
    else logger.error(`(CRON) Summary of article ${failure.id} failed:`, failure.error);
  }
}
