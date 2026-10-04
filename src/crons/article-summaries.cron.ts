import { logger } from "../logger";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { createModels } from "../services/ai/model";
import { GeminiError } from "../services/ai/gemini-error";
import { createArticleSummarizer, createSummaryJob } from "../services/article-summary.service";

const models = createModels();

// Without GEMINI_API_KEY there are no summaries; the page then shows the full text only
const job = models
  ? createSummaryJob({
      summarizer: createArticleSummarizer({ model: models("summary") }),
      // Only into the database the run started on (skipped when a demo switch happened meanwhile)
      beginRun: () => {
        const generation = currentGeneration();
        return (fn) => runTracked(fn, { generation });
      },
    })
  : null;

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
  if (!job) return;
  const { done, failed } = await job.run();
  if (done.length > 0) logger.info(`(CRON) Summarised articles ${done.join(", ")}`);
  for (const failure of failed) logger.warn(`(CRON) Summary of article ${failure.id} failed: ${describe(failure.error)}`);
}
