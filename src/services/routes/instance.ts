import { createReachService } from "../reach/reach.service";
import { createGraphHopperRouter } from "./graphhopper.client";
import { createTrailsService } from "./trails.service";

const router = createGraphHopperRouter(process.env.ROUTER_URL || undefined);
const configured = () => !!process.env.ROUTER_URL;

export const trailsService = createTrailsService({ router, configured });
export const reachService = createReachService({ router, trails: () => trailsService.trails(), configured });
