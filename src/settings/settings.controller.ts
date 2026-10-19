import { Request, Response } from "express";
import { logger } from "../logger";
import { getHuntableAreas, setHuntableAreas } from "./huntable-areas-setting";
import { getRoutesSetting, setRoutesSetting } from "./night-areas-setting";
import { isPredictionEnabled, setPredictionEnabled } from "./prediction-setting";

export function getPredictionSetting(_req: Request, res: Response) {
  return res.status(200).json({ enabled: isPredictionEnabled() });
}

export async function putPredictionSetting(req: Request, res: Response) {
  const enabled = await setPredictionEnabled(req.body.enabled === true, req.user?.name ?? null);
  logger.info(`Fox prediction ${enabled ? "enabled" : "disabled"} by ${req.user?.name ?? req.user?._id}`);
  return res.status(200).json({ enabled });
}

export function getHuntableAreasSetting(_req: Request, res: Response) {
  return res.status(200).json({ areas: getHuntableAreas() });
}

export async function putHuntableAreasSetting(req: Request, res: Response) {
  const areas = await setHuntableAreas(req.body.areas, req.user?.name ?? null);
  logger.info(`Huntable areas set to ${areas.length ? areas.join(", ") : "(none)"} by ${req.user?.name ?? req.user?._id}`);
  return res.status(200).json({ areas });
}

export function getNightAreasSetting(_req: Request, res: Response) {
  return res.status(200).json(getRoutesSetting());
}

export async function putNightAreasSetting(req: Request, res: Response) {
  const setting = await setRoutesSetting({ enabled: req.body.enabled, areas: req.body.areas }, req.user?.name ?? null);
  logger.info(`Routes setting set (enabled=${setting.enabled}, ${setting.areas.length} areas) by ${req.user?.name ?? req.user?._id}`);
  return res.status(200).json(setting);
}
