import { afterEach, expect, spyOn, test } from "bun:test";
import { setArchiveFlag } from "../editions/work-tracking";
import { predictionService } from "../services/prediction/instance";
import * as notifierService from "../services/notifier.service";
import * as aiModel from "../services/ai/model";
import recomputePredictions from "./prediction.cron";
import notify from "./notifier.cron";
import summarizeArticles from "./article-summaries.cron";
import splitHints from "./hint-split.cron";

afterEach(() => setArchiveFlag(false));

test("while an archive is shown the prediction, notifier, summary and hint-split crons do nothing", async () => {
  const recompute = spyOn(predictionService, "recomputeDue").mockResolvedValue({ recomputed: [], failed: [] });
  const runNotifier = spyOn(notifierService, "runNotifier").mockResolvedValue([]);
  const aiAvailable = spyOn(aiModel, "aiAvailable").mockReturnValue(false);
  try {
    setArchiveFlag(true);
    await recomputePredictions();
    await notify();
    await summarizeArticles();
    await splitHints();
    expect(recompute).not.toHaveBeenCalled();
    expect(runNotifier).not.toHaveBeenCalled();
    // Skipped before the AI check
    expect(aiAvailable).not.toHaveBeenCalled();

    setArchiveFlag(false);
    await recomputePredictions();
    expect(recompute).toHaveBeenCalledTimes(1);
  } finally {
    recompute.mockRestore();
    runNotifier.mockRestore();
    aiAvailable.mockRestore();
  }
});
