import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/** What a Gemini call is for; each purpose has its own model setting */
export type AiPurpose = "ocr" | "prediction" | "chat" | "summary";

/** Default model for reading stickers (OCR), summaries and chat */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
/** Default model for the fox prediction */
export const DEFAULT_PREDICTION_MODEL = "gemini-pro-latest";

const MODEL_SETTING: Record<AiPurpose, { variable: string; fallback: string }> = {
  ocr: { variable: "GEMINI_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  summary: { variable: "GEMINI_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  chat: { variable: "GEMINI_CHAT_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  prediction: { variable: "GEMINI_PREDICTION_MODEL", fallback: DEFAULT_PREDICTION_MODEL },
};

/**
 * The Gemini models of this server, by purpose. Null without GEMINI_API_KEY: every AI feature is then off.
 * `baseURL` is only for tests (a local server in place of Google).
 */
export function createModels(env: Record<string, string | undefined> = process.env, baseURL?: string): ((purpose: AiPurpose) => LanguageModel) | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const google = createGoogleGenerativeAI({ apiKey, baseURL });
  return (purpose) => {
    const { variable, fallback } = MODEL_SETTING[purpose];
    return google(env[variable]?.trim() || fallback);
  };
}
