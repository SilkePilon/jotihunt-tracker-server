import { logger } from "../logger";
import { createTraccarApi } from "./traccar-api";
import { describeTraccarError, traccarHttp } from "./traccar-http";
import * as traccarService from "./traccar.service";
import { vehicleGroupsFromEnv } from "./tracker-onboarding.helpers";
import { createTrackerOnboarding } from "./tracker-onboarding.service";

/** Vehicle → Traccar group ids from the environment (read once at start). */
export const vehicleGroups = vehicleGroupsFromEnv();

/** The app-wide onboarding service (Traccar device per user); shared by the tracker and pairing routes. */
export const onboarding = createTrackerOnboarding({
  api: traccarService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  clientUrl: process.env.TRACCAR_CLIENT_URL,
  groups: vehicleGroups,
  onError: (error) => logger.warn(`Traccar onboarding: ${describeTraccarError(error)}`),
});
