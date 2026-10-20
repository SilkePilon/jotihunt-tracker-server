import { logger } from "../logger";
import { currentGeneration, runTracked, skipWhenArchive } from "../editions/work-tracking";
import { jotihuntLogin } from "../services/jotihunt-scraper.service";
import { readScore, recordScore, recordScoreFailure } from "../services/score-sync.service";
import type { SiteScore } from "../services/jotihunt-score.parse";
import { deadline } from "../services/http-limits";

/** One read (login included) may take this long */
export const SCORE_DEADLINE_MS = 60_000;

/**
 * Read our provisional score from the jotihunt.nl dashboard (every 2 minutes, only with a login set in Beheer). The
 * read is not tracked (slow, no database); storing is, and only into the database the run started on. `read` is
 * replaceable for tests.
 */
export default async function syncJotihuntScore(options: { read?: () => Promise<SiteScore> } = {}): Promise<void> {
  if (skipWhenArchive("jotihunt-score", (message) => logger.debug(message))) return;
  if (!jotihuntLogin()) return;

  const generation = currentGeneration();
  let score: SiteScore | null = null;
  let failure: unknown = null;
  try {
    score = await deadline((options.read ?? readScore)(), SCORE_DEADLINE_MS, `Reading the score took longer than ${SCORE_DEADLINE_MS / 1000} s`);
  } catch (error) {
    failure = error;
    logger.error("(CRON) Reading the score failed:", error);
  }
  await runTracked(() => (score ? recordScore(score) : recordScoreFailure(failure)), { generation });
}
