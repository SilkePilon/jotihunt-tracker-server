import { logger } from "../logger";
import { createTraccarApi } from "./traccar-api";
import { describeTraccarError, traccarHttp } from "./traccar-http";
import * as traccarService from "./traccar.service";
import { onAppConfigChange } from "../settings/app-config";
import { syncVehicleGroups, type VehicleGroups } from "./tracker-onboarding.helpers";
import { createTrackerOnboarding } from "./tracker-onboarding.service";

/** Vehicle → Traccar group ids (Beheer, else env); one shared object, synced in place when the config changes. */
export const vehicleGroups = {} as VehicleGroups;
syncVehicleGroups(vehicleGroups);
onAppConfigChange((part) => part === "general" && syncVehicleGroups(vehicleGroups));

/** The app-wide onboarding service (Traccar device per user); shared by the tracker and pairing routes. */
export const onboarding = createTrackerOnboarding({
  api: traccarService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  clientUrl: process.env.TRACCAR_CLIENT_URL,
  groups: vehicleGroups,
  onError: (error) => logger.warn(`Traccar onboarding: ${describeTraccarError(error)}`),
});
