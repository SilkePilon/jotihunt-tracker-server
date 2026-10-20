import { logger } from "../logger";
import { currentGeneration, runTracked } from "../editions/work-tracking";
import { aiAvailable, requireAiModel } from "../services/ai/model";
import { GeminiError } from "../services/ai/gemini-error";
import { createHintSplitJob, createHintSplitter } from "../services/hint-split.service";

// Without a Gemini key the hint cells keep the split made by the rule (hint-parser).
// Built once (the job keeps its backoff); the model is read per article, so a key or model set in Beheer applies at once
const job = createHintSplitJob({
  splitter: { split: (article, areas) => createHintSplitter({ model: requireAiModel("split") }).split(article, areas) },
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

/** Let Gemini correct the per-area split of new or changed hint articles (one per run) */
export default async function splitHints() {
  if (!aiAvailable()) return;
  const { done, failed } = await job.run();
  if (done.length > 0) logger.info(`(CRON) Split hint articles ${done.join(", ")}`);
  for (const failure of failed) {
    // A Gemini failure (rate limit, quota, bad answer) is expected and stays a warning; anything else is a bug and an issue
    if (failure.error instanceof GeminiError || !(failure.error instanceof Error)) logger.warn(`(CRON) Split of hint article ${failure.id} failed: ${describe(failure.error)}`);
    else logger.error(`(CRON) Split of hint article ${failure.id} failed:`, failure.error);
  }
}
