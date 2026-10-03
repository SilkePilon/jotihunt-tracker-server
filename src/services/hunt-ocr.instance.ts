import axios from "axios";
import { readFile } from "node:fs/promises";
import { logger } from "../logger";
import { onDemoSwitch } from "../demo/database-switch";
import { runTracked } from "../demo/demo-mode";
import { createGeminiClient, DEFAULT_GEMINI_MODEL, GeminiError } from "./gemini.client";
import { createHuntOcr, type HuntOcr } from "./hunt-ocr.service";
import { removeOrphanPhotos } from "./hunt-report.service";
import { photoFilePath } from "./photo-store";

/** Only the error class and our own message: never the raw error (an axios error holds the API key header). */
function describeOcrError(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error) return `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`;
  return "unknown error";
}

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

/** Background reading of hunt codes and times; without GEMINI_API_KEY every reading fails with a clear message. */
const queue = createHuntOcr({
  reader: geminiApiKey ? createGeminiClient({ apiKey: geminiApiKey, model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL, http: axios.create() }) : null,
  loadPhoto: (name) => readFile(photoFilePath(name)),
  onError: (error, reportId) => logger.warn(`OCR of hunt report ${reportId} failed: ${describeOcrError(error)}`),
});

/** Clean up photo files left by a crash mid-upload (tracked: never while a demo switch changes the directory) */
async function removeCrashLeftovers() {
  try {
    const removed = await runTracked(() => removeOrphanPhotos());
    if (removed) logger.info(`Removed ${removed} hunt photo(s) without a report (left by a crash mid-upload)`);
  } catch (error) {
    logger.warn(`Could not clean up hunt photos without a report: ${describeOcrError(error)}`);
  }
}

/**
 * resumePending runs at startup and after every demo switch, i.e. exactly when work left by a restart is picked up:
 * it also removes the photos a crash mid-upload left behind.
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
