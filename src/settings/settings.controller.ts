import { Request, Response } from "express";
import { logger } from "../logger";
import { isPredictionEnabled, setPredictionEnabled } from "./prediction-setting";

export function getPredictionSetting(_req: Request, res: Response) {
  return res.status(200).json({ enabled: isPredictionEnabled() });
}

export async function putPredictionSetting(req: Request, res: Response) {
  const enabled = await setPredictionEnabled(req.body.enabled === true, req.user?.name ?? null);
  logger.info(`Fox prediction ${enabled ? "enabled" : "disabled"} by ${req.user?.name ?? req.user?._id}`);
  return res.status(200).json({ enabled });
}
