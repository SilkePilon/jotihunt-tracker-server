import { createModels } from "../ai/model";
import { createGeminiPredictor } from "./gemini-predictor";
import { createOrsRouter } from "./ors.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createWalkMinutes } from "./walking";

const models = createModels();

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  predictor: models ? createGeminiPredictor({ model: models("prediction") }) : null,
  walkMinutes: createWalkMinutes({ walking: createOrsRouter(process.env.ORS_API_KEY || undefined), fallback: straightLineRouter }),
});
