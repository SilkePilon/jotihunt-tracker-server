import * as traccarrService from "../services/traccarr.service";
import { Request, Response } from "express";
import { logger } from "..";
import { createTraccarApi } from "../services/traccar-api";
import { traccarHttp } from "../services/traccar-http";
import { vehicleGroupsFromEnv, type Vehicle } from "../services/tracker-onboarding.helpers";
import { createTrackerOnboarding } from "../services/tracker-onboarding.service";

const onboarding = createTrackerOnboarding({
  api: traccarrService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  clientUrl: process.env.TRACCAR_CLIENT_URL,
  groups: vehicleGroupsFromEnv(),
  onError: (error) => logger.warn("Traccar onboarding: Traccar request failed", error),
});

function traccarUnavailable(res: Response) {
  return res.status(503).json({ message: "Traccar is not configured" });
}

async function getDevices(_req: Request, res: Response) {
  if (!traccarrService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const devices = await traccarrService.getDevices();
    const groups = await traccarrService.getGroups();
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
  if (!traccarrService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const positions = await traccarrService.getPositions();
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

export { getDevices, getPositions, getMe, putVehicle };
