import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { aiModelId, secret, type AiSlot } from "../../settings/app-config";
import { GeminiError } from "./gemini-error";

export { DEFAULT_GEMINI_MODEL, DEFAULT_PREDICTION_MODEL } from "../../settings/app-config";
/** What a Gemini call is for; each has its own model in Beheer → AI */
export type AiPurpose = AiSlot;

export const NO_KEY_MESSAGE = "Geen Gemini-sleutel ingesteld";

let provider: { apiKey: string; baseURL: string | undefined; google: GoogleGenerativeAIProvider } | null = null;
let baseURLOverride: string | undefined;

/** Tests only: a local server in place of Google */
export function setAiBaseUrl(url: string | undefined) {
  baseURLOverride = url;
  provider = null;
}

/** True when a Gemini key is set (Beheer, else GEMINI_API_KEY) */
export function aiAvailable(): boolean {
  return secret("geminiApiKey") !== null;
}

/** The model for `slot`, read now (a key or model changed in Beheer applies to the next call); null without a key. */
export function aiModel(slot: AiSlot): LanguageModel | null {
  const apiKey = secret("geminiApiKey");
  if (!apiKey) return null;
  if (!provider || provider.apiKey !== apiKey || provider.baseURL !== baseURLOverride) {
    provider = { apiKey, baseURL: baseURLOverride, google: createGoogleGenerativeAI({ apiKey, baseURL: baseURLOverride }) };
  }
  return provider.google(aiModelId(slot).value);
}

/** Like aiModel, but a missing key is a (non-retryable) GeminiError, as for any other failed call */
export function requireAiModel(slot: AiSlot): LanguageModel {
  const model = aiModel(slot);
  if (!model) throw new GeminiError(NO_KEY_MESSAGE, false);
  return model;
}
