import { logger } from "../logger";
import { SiteScore } from "../models/site-score.model";
import { syncErrorText } from "./hunt-sync-state";
import { fetchPage, isNotASitePage, jotihuntLogin } from "./jotihunt-scraper.service";
import { parseScorePage, type ScoreParts, type SiteScore as ParsedScore } from "./jotihunt-score.parse";

/** The dashboard with the score card */
export const DASHBOARD_PATH = "/scoutingGroup/dashboard";

/** GET /score */
export interface ScoreView {
  /** A jotihunt.nl login is set in Beheer */
  configured: boolean;
  lastSuccessAt: string | null;
  /** Short Dutch text of the last failed read; null once a read succeeds */
  lastError: string | null;
  total: number | null;
  parts: ScoreParts;
  previousTotal: number | null;
  changedAt: string | null;
}

/** Warn once (until the card is found again) when the dashboard shows no score card: the cron runs every 2 minutes */
let warnedNoCard = false;

/**
 * Store a successful read: the score, and when the total changed (not on the first read) the old total and the
 * time. Clears lastError.
 */
export async function recordScore(score: ParsedScore, now = new Date()): Promise<void> {
  const stored = await SiteScore.findOne({ key: "score" }).lean();
  const changed = stored?.lastSuccessAt != null && stored.total !== score.total;
  await SiteScore.updateOne(
    { key: "score" },
    {
      $set: {
        total: score.total,
        parts: score.parts,
        lastSuccessAt: now,
        lastAttemptAt: now,
        lastError: null,
        ...(changed && { previousTotal: stored.total ?? null, changedAt: now }),
      },
    },
    { upsert: true },
  );
}

/** Store a failed read: the short Dutch error; the last score stays */
export async function recordScoreFailure(error: unknown, now = new Date()): Promise<void> {
  await SiteScore.updateOne({ key: "score" }, { $set: { lastAttemptAt: now, lastError: syncErrorText(error) } }, { upsert: true });
}

/** Read the dashboard with the shared session and parse the score card; throws when the page or card is missing */
export async function readScore(): Promise<ParsedScore> {
  const { status, html } = await fetchPage(DASHBOARD_PATH);
  if (status < 200 || status >= 300) throw new Error(`GET ${DASHBOARD_PATH} → ${status}`);
  const score = parseScorePage(html);
  if (!score) {
    if (!warnedNoCard) logger.warn(`(SCORE) No score card on ${DASHBOARD_PATH}${isNotASitePage(html) ? " (Cloudflare or server error)" : " (new layout?)"}`);
    warnedNoCard = true;
    throw new Error("No score card on the dashboard");
  }
  warnedNoCard = false;
  return score;
}

export async function scoreView(): Promise<ScoreView> {
  const stored = await SiteScore.findOne({ key: "score" }).lean();
  const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
  const parts = stored?.parts;
  return {
    configured: jotihuntLogin() !== null,
    lastSuccessAt: iso(stored?.lastSuccessAt),
    lastError: stored?.lastError ?? null,
    total: stored?.total ?? null,
    parts: {
      hunts: parts?.hunts ?? null,
      counterHunts: parts?.counterHunts ?? null,
      assignments: parts?.assignments ?? null,
      photoAssignments: parts?.photoAssignments ?? null,
      hints: parts?.hints ?? null,
      penalty: parts?.penalty ?? null,
    },
    previousTotal: stored?.previousTotal ?? null,
    changedAt: iso(stored?.changedAt),
  };
}

/** For tests */
export function resetScoreWarning(): void {
  warnedNoCard = false;
}
