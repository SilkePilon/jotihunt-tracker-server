import { logger } from "../logger";
import { runTracked } from "../editions/work-tracking";
import { isPredictionEnabled } from "../settings/prediction-setting";
import { predictionService } from "../services/prediction/instance";

async function recompute() {
  const { recomputed, failed } = await predictionService.recomputeDue();
  if (recomputed.length > 0) logger.info(`(CRON) Recomputed fox predictions for ${recomputed.join(", ")}`);
  // With the Error as meta: bugs become Sentry issues, Gemini/ORS outages do not (see isExpectedOutage)
  for (const failure of failed) logger.error(`(CRON) Fox prediction for ${failure.area} failed:`, failure.error);
}

/** Tracked, so a demo switch waits for it (and it is skipped while a switch runs). */
export default async function recomputePredictions() {
  if (!isPredictionEnabled()) return; // switched off by an admin: no Gemini or ORS calls
  await runTracked(recompute);
}
