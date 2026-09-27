import { createOrsRouter } from "./ors.client";
import { createOverpassSource } from "./overpass.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createTransitousPlanner } from "./transitous.client";

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  walking: createOrsRouter(process.env.ORS_API_KEY || undefined),
  fallback: straightLineRouter,
  transit: createTransitousPlanner(),
});

export const stopSource = createOverpassSource();
