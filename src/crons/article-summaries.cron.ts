import { logger } from "../logger";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { createModels } from "../services/ai/model";
import { GeminiError } from "../services/ai/gemini-error";
import { createArticleSummarizer, createSummaryJob } from "../services/article-summary.service";

const models = createModels();
let generation = currentGeneration();

// Without GEMINI_API_KEY there are no summaries; the page then shows the full text only
const job = models
  ? createSummaryJob({
      summarizer: createArticleSummarizer({ model: models("summary") }),
      // Only into the database the run started on (skipped when a demo switch happened meanwhile)
      tracked: (fn) => runTracked(fn, { generation }),
    })
  : null;

/** Only our own message: never the raw error (an API error holds the request, with the key) */
const describe = (error: unknown) => (error instanceof GeminiError ? error.message : error instanceof Error ? error.name : "unknown error");

/** Summarise new or changed news and assignment articles (a few per run) */
export default async function summarizeArticles() {
  if (!job) return;
  generation = currentGeneration();
  const { done, failed } = await job.run();
  if (done.length > 0) logger.info(`(CRON) Summarised articles ${done.join(", ")}`);
  for (const failure of failed) logger.warn(`(CRON) Summary of article ${failure.id} failed: ${describe(failure.error)}`);
}
