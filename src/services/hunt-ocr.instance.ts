import { readFile } from "node:fs/promises";
import { logger } from "../logger";
import { onDemoSwitch } from "../demo/database-switch";
import { runTracked } from "../demo/demo-mode";
import { aiModel } from "./ai/model";
import { createGeminiClient, GeminiError } from "./gemini.client";
import { createHuntOcr, type HuntOcr } from "./hunt-ocr.service";
import { removeOrphanPhotos, restoreMissingHuntMarkers } from "./hunt-report.service";
import { photoFilePath } from "./photo-store";

/** Only the error class and our own message: never the raw error (an API error holds the request, with the key). */
function describeOcrError(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error) return `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`;
  return "unknown error";
}

/** Background reading of hunt codes and times; without a Gemini key every reading fails with a clear message. */
const queue = createHuntOcr({
  reader: () => {
    const model = aiModel("ocr");
    return model ? createGeminiClient({ model }) : null;
  },
  loadPhoto: (name) => readFile(photoFilePath(name)),
  onError: (error, reportId) => logger.warn(`OCR of hunt report ${reportId} failed: ${describeOcrError(error)}`),
});

/** Repair what a crash mid-upload left behind (tracked: never while a demo switch changes the database or directory) */
async function removeCrashLeftovers() {
  try {
    const removed = await runTracked(() => removeOrphanPhotos());
    if (removed) logger.info(`Removed ${removed} hunt photo(s) without a report (left by a crash mid-upload)`);
  } catch (error) {
    logger.warn(`Could not clean up hunt photos without a report: ${describeOcrError(error)}`);
  }
  try {
    const restored = await runTracked(() => restoreMissingHuntMarkers());
    if (restored) logger.info(`Restored ${restored} hunt marker(s) lost by a crash mid-upload`);
  } catch (error) {
    logger.warn(`Could not restore missing hunt markers: ${describeOcrError(error)}`);
  }
}

/**
 * resumePending runs at startup and after every demo switch, i.e. exactly when work left by a restart is picked up:
 * it also repairs what a crash mid-upload left behind.
 */
export const huntOcr: HuntOcr = {
  ...queue,
  async resumePending() {
    await removeCrashLeftovers();
    return queue.resumePending();
  },
};

// Report ids belong to one database: after a demo switch, forget the queue and pick up the new database's pending reports
onDemoSwitch(async () => {
  huntOcr.reset();
  const count = await huntOcr.resumePending();
  if (count > 0) logger.info(`Resumed reading ${count} hunt report photo(s) after the demo switch`);
});
