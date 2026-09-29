import { GeminiError, generateJson, type GeminiHttp } from "../gemini.client";
import { PREDICTION_SCHEMA } from "./prompt";

export const DEFAULT_PREDICTION_MODEL = "gemini-pro-latest";
const TIMEOUT_MS = 90_000;

export interface FoxPredictor {
  /** Parsed JSON answer (not yet validated). Throws GeminiError. */
  predict(prompt: string): Promise<unknown>;
}

export function createGeminiPredictor({ apiKey, model, http }: { apiKey: string; model: string; http: GeminiHttp }): FoxPredictor {
  return {
    async predict(prompt) {
      const text = await generateJson({
        http,
        apiKey,
        model,
        parts: [{ text: prompt }],
        generationConfig: { responseSchema: PREDICTION_SCHEMA, temperature: 0.2 },
        timeoutMs: TIMEOUT_MS,
      });
      try {
        return JSON.parse(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
