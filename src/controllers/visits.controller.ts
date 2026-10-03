import { Request, Response } from "express";
import { logger } from "../logger";
import { isPredictionEnabled } from "../settings/prediction-setting";
import { predictionService } from "../services/prediction/instance";
import { listCurrentVisits, setManualVisit, type VisitInput } from "../services/prediction/visit.service";

export async function getVisits(_req: Request, res: Response) {
  if (!isPredictionEnabled()) return res.status(200).json([]);
  return res.status(200).json(await listCurrentVisits());
}

export async function putVisit(req: Request, res: Response) {
  if (!isPredictionEnabled()) return res.status(409).json({ message: "AI-voorspelling staat uit." });
  const teamApiId = Number(req.params.teamApiId);
  const result = await setManualVisit(teamApiId, req.body.state as VisitInput);
  if (!result) return res.status(404).json({ message: "Groep niet gevonden of niet gekoppeld aan een deelgebied." });
  // Recompute in the background so the response stays fast (Gemini can take tens of seconds)
  predictionService.recomputeArea(result.area).catch((error) => logger.error(`Recomputing prediction for ${result.area} failed`, error));
  return res.status(200).json(result.visit);
}
