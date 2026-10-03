import axios from "axios";
import { readFile } from "node:fs/promises";
import { logger } from "../logger";
import { onDemoSwitch } from "../demo/database-switch";
import { createGeminiClient, DEFAULT_GEMINI_MODEL, GeminiError } from "./gemini.client";
import { createHuntOcr } from "./hunt-ocr.service";
import { photoFilePath } from "./photo-store";

/** Only the error class and our own message: never the raw error (an axios error holds the API key header). */
function describeOcrError(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error) return `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`;
  return "unknown error";
}

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

/** Background reading of hunt codes and times; without GEMINI_API_KEY every reading fails with a clear message. */
export const huntOcr = createHuntOcr({
  reader: geminiApiKey ? createGeminiClient({ apiKey: geminiApiKey, model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL, http: axios.create() }) : null,
  loadPhoto: (name) => readFile(photoFilePath(name)),
  onError: (error, reportId) => logger.warn(`OCR of hunt report ${reportId} failed: ${describeOcrError(error)}`),
});

// Report ids belong to one database: after a demo switch, forget the queue and pick up the new database's pending reports
onDemoSwitch(async () => {
  huntOcr.reset();
  const count = await huntOcr.resumePending();
  if (count > 0) logger.info(`Resumed reading ${count} hunt report photo(s) after the demo switch`);
});
