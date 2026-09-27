import * as traccarrService from "../services/traccarr.service";
import { Request, Response } from "express";

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

export { getDevices, getPositions };
