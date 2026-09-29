import axios from "axios";
import { createGeminiPredictor, DEFAULT_PREDICTION_MODEL } from "./gemini-predictor";
import { createOrsRouter } from "./ors.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createWalkMinutes } from "./walking";

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  predictor: geminiApiKey
    ? createGeminiPredictor({ apiKey: geminiApiKey, model: process.env.GEMINI_PREDICTION_MODEL?.trim() || DEFAULT_PREDICTION_MODEL, http: axios.create() })
    : null,
  walkMinutes: createWalkMinutes({ walking: createOrsRouter(process.env.ORS_API_KEY || undefined), fallback: straightLineRouter }),
});
