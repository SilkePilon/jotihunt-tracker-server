import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { toGeminiError } from "../ai/gemini-error";
import { PREDICTION_SCHEMA } from "./prompt";

const TIMEOUT_MS = 90_000;

export interface FoxPredictor {
  /** Parsed JSON answer (not yet validated). Throws GeminiError. */
  predict(prompt: string): Promise<unknown>;
}

/** One Gemini call per prediction; retrying and pausing are the prediction service's job */
export function createGeminiPredictor({ model, timeoutMs = TIMEOUT_MS }: { model: LanguageModel; timeoutMs?: number }): FoxPredictor {
  return {
    async predict(prompt) {
      try {
        const result = await generateText({
          model,
          prompt,
          // No validator: validate.ts checks the answer and reports what is wrong with it
          output: Output.object({ schema: jsonSchema(PREDICTION_SCHEMA as unknown as JSONSchema7) }),
          temperature: 0.2,
          maxRetries: 0,
          timeout: timeoutMs,
        });
        // Reading the output throws when the answer was empty: inside the try so it becomes a GeminiError too
        return result.output;
      } catch (error) {
        throw toGeminiError(error);
      }
    },
  };
}
