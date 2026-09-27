import { logger } from "..";
import { TransitStop } from "../models/transit-stop.model";
import { predictionService, stopSource } from "../services/prediction/instance";
import { refreshTransitStops } from "../services/prediction/transit-stop.service";

const STOP_RETRY_MS = 60 * 60 * 1000;
let lastStopAttempt = 0;

/** Fetch transit stops once (retry at most hourly while the collection is empty). */
async function ensureTransitStops() {
  if (Date.now() - lastStopAttempt < STOP_RETRY_MS) return;
  if ((await TransitStop.estimatedDocumentCount()) > 0) return;
  lastStopAttempt = Date.now();
  refreshTransitStops(stopSource)
    .then((count) => logger.info(`(CRON) Stored ${count} transit stops`))
    .catch((error) => logger.warn("(CRON) Could not fetch transit stops", error));
}

export default async function recomputePredictions() {
  await ensureTransitStops();
  const { recomputed, failed } = await predictionService.recomputeDue();
  if (recomputed.length > 0) logger.info(`(CRON) Recomputed fox predictions for ${recomputed.join(", ")}`);
  for (const failure of failed) logger.error(`(CRON) Fox prediction for ${failure.area} failed`, failure.error);
}
