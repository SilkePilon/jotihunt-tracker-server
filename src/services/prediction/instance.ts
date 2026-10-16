import { aiModel } from "../ai/model";
import { createGeminiPredictor } from "./gemini-predictor";
import { createOrsRouter } from "./ors.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createWalkMinutes } from "./walking";

/** Walking minutes via ORS (one daily quota and circuit breaker, shared by the prediction and the Intel chat) */
export const walkMinutes = createWalkMinutes({ walking: createOrsRouter(process.env.ORS_API_KEY || undefined), fallback: straightLineRouter });

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  predictor: () => {
    const model = aiModel("prediction");
    return model ? createGeminiPredictor({ model }) : null;
  },
  walkMinutes,
});
