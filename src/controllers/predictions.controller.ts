import { Request, Response } from "express";
import { logger } from "..";
import { predictionService, stopSource } from "../services/prediction/instance";
import { listPredictions } from "../services/prediction/prediction.service";
import { refreshTransitStops } from "../services/prediction/transit-stop.service";
import { listCurrentVisits, setManualVisit, type VisitInput } from "../services/prediction/visit.service";

export async function getPredictions(_req: Request, res: Response) {
  return res.status(200).json(await listPredictions());
}

export async function getVisits(_req: Request, res: Response) {
  return res.status(200).json(await listCurrentVisits());
}

export async function putVisit(req: Request, res: Response) {
  const teamApiId = Number(req.params.teamApiId);
  const result = await setManualVisit(teamApiId, req.body.state as VisitInput);
  if (!result) return res.status(404).json({ message: "Groep niet gevonden of niet gekoppeld aan een deelgebied." });
  // Recompute in the background so the response stays fast (routing can take seconds)
  predictionService.recomputeArea(result.area).catch((error) => logger.error(`Recomputing prediction for ${result.area} failed`, error));
  return res.status(200).json(result.visit);
}

export async function refreshStops(_req: Request, res: Response) {
  try {
    return res.status(200).json({ count: await refreshTransitStops(stopSource) });
  } catch (error) {
    logger.error("Refreshing transit stops failed", error);
    return res.status(502).json({ message: "Haltes ophalen is mislukt, probeer het later opnieuw." });
  }
}
