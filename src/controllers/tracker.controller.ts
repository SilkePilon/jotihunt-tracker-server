import * as traccarService from "../services/traccar.service";
import { Request, Response } from "express";
import { logger } from "../logger";
import { createTraccarApi } from "../services/traccar-api";
import { describeTraccarError, traccarHttp } from "../services/traccar-http";
import { vehicleGroupsFromEnv, type Vehicle } from "../services/tracker-onboarding.helpers";
import { createTrackerOnboarding } from "../services/tracker-onboarding.service";
import { isDemoMode } from "../demo/demo-mode";
import { setSimulatedVehicle, simulatedDevices, simulatedPositions } from "../demo/simulated-trackers";

const vehicleGroups = vehicleGroupsFromEnv();

const onboarding = createTrackerOnboarding({
  api: traccarService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  clientUrl: process.env.TRACCAR_CLIENT_URL,
  groups: vehicleGroups,
  onError: (error) => logger.warn(`Traccar onboarding: ${describeTraccarError(error)}`),
});

function traccarUnavailable(res: Response) {
  return res.status(503).json({ message: "Traccar is not configured" });
}

async function getDevices(_req: Request, res: Response) {
  // Demo mode: the simulated hunters instead of Traccar (positions follow the clock)
  if (isDemoMode()) return res.json(simulatedDevices(new Date(), vehicleGroups));
  if (!traccarService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const [devices, groups] = await Promise.all([traccarService.getDevices(), traccarService.getGroups()]);
    devices.forEach((device) => {
      const group = groups.find((group) => group.id === device.groupId);
      device.groupName = group ? group.name : undefined;
    });
    res.json(devices);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
}

async function getPositions(_req: Request, res: Response) {
  if (isDemoMode()) return res.json(simulatedPositions(new Date()));
  if (!traccarService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const positions = await traccarService.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
}

async function getMe(req: Request, res: Response) {
  return res.status(200).json(await onboarding.getMe(req.user!));
}

async function putVehicle(req: Request, res: Response) {
  return res.status(200).json(await onboarding.setVehicle(req.user!, req.body.vehicle as Vehicle));
}

/** Admin: PUT /admin/devices/:id/vehicle — change any hunter's vehicle (Traccar group / map icon). */
async function putDeviceVehicle(req: Request, res: Response) {
  if (isDemoMode()) {
    const simulated = setSimulatedVehicle(Number(req.params.id), req.body.vehicle as Vehicle, vehicleGroups);
    if (simulated) return res.status(200).json(simulated);
  }
  if (!traccarService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const result = await onboarding.setDeviceVehicle(Number(req.params.id), req.body.vehicle as Vehicle);
    if (!result) return res.status(404).json({ message: "Toestel niet gevonden." });
    return res.status(200).json(result);
  } catch (error) {
    logger.warn(`Admin vehicle change: ${describeTraccarError(error)}`);
    return res.status(502).json({ message: "Traccar gaf een fout, probeer het opnieuw." });
  }
}

export { getDevices, getPositions, getMe, putVehicle, putDeviceVehicle };
