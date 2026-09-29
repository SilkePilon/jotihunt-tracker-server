import { Request, Response } from "express";
import { logger } from "..";
import { DemoSwitchBusyError, getDemoState, switchDemoMode } from "./database-switch";

export function getDemo(_req: Request, res: Response) {
  return res.status(200).json(getDemoState());
}

export async function postDemo(req: Request, res: Response) {
  const enabled = req.body.enabled === true;
  logger.info(`Demo mode ${enabled ? "on" : "off"} requested by user ${req.user?._id}`);
  try {
    const state = await switchDemoMode(enabled, req.user);
    return res.status(200).json(state);
  } catch (error) {
    // Requests or background jobs kept running: nothing changed, the app stays on the current database
    if (error instanceof DemoSwitchBusyError) return res.status(409).json({ message: error.message });
    throw error;
  }
}
