import { logger } from "../logger";
import { currentGeneration, runTracked, skipWhenArchive } from "../editions/work-tracking";
import { assignmentsToCheck, markSiteAttempt, storeSubmission } from "../services/assignment-sync.service";
import { deadline } from "../services/http-limits";
import { parseAssignmentPage } from "../services/jotihunt-assignment.parse";
import { fetchPage, jotihuntLogin } from "../services/jotihunt-scraper.service";

/** One page (a login included) may take this long */
export const PAGE_DEADLINE_MS = 30_000;

interface Options {
  /** GET a logged-in page; replaceable for tests */
  fetch?: (path: string) => Promise<{ status: number; html: string }>;
  now?: () => Date;
}

/**
 * Read back what we handed in on jotihunt.nl (every 5 minutes, only with a login set in Beheer): open up to 5 assignment
 * pages that are not judged yet and store their Insturen card on the assignment. A failing page is logged and skipped;
 * a failed login ends the run.
 */
export default async function syncJotihuntAssignments(options: Options = {}): Promise<void> {
  if (skipWhenArchive("jotihunt-assignments", (message) => logger.debug(message))) return;
  if (!jotihuntLogin()) return;
  const get = options.fetch ?? fetchPage;
  const now = options.now ?? (() => new Date());

  const generation = currentGeneration();
  const ids = await assignmentsToCheck(now());
  for (const id of ids) {
    const path = `/bericht/${id}`;
    try {
      // Before the fetch: a page that fails or has no Insturen card goes to the back of the queue
      await runTracked(() => markSiteAttempt(id, now()), { generation });
      const { status, html } = await deadline(get(path), PAGE_DEADLINE_MS, `GET ${path} took longer than ${PAGE_DEADLINE_MS / 1000} s`);
      if (status < 200 || status >= 300) throw new Error(`GET ${path} → ${status}`);
      const { found, ...page } = parseAssignmentPage(html);
      if (!found) {
        logger.warn(`(ASSIGNMENTS) No Insturen card on ${path}`);
        continue;
      }
      const changed = await runTracked(() => storeSubmission(id, page, now()), { generation });
      if (changed) logger.info(`(ASSIGNMENTS) Assignment ${id} is handed in on jotihunt.nl: status submitted`);
    } catch (error) {
      logger.error(`(ASSIGNMENTS) Checking assignment ${id} failed:`, error);
      if (error instanceof Error && /login failed/i.test(error.message)) return;
    }
  }
}
