import { Request, Response } from "express";
import { logger } from "../logger";
import { getDemoState, switchDemoMode } from "./database-switch";

export function getDemo(_req: Request, res: Response) {
  return res.status(200).json(getDemoState());
}

export async function postDemo(req: Request, res: Response) {
  const enabled = req.body.enabled === true;
  logger.info(`Demo mode ${enabled ? "on" : "off"} requested by user ${req.user?._id}`);
  // A DemoSwitchBusyError (status 409: requests or jobs kept running, nothing changed) is mapped by the global error handler
  const state = await switchDemoMode(enabled, req.user);
  return res.status(200).json(state);
}
