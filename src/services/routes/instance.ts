import { createGraphHopperRouter } from "./graphhopper.client";
import { createTrailsService } from "./trails.service";

export const trailsService = createTrailsService({ router: createGraphHopperRouter(process.env.ROUTER_URL || undefined) });
