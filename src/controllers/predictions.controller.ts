import { Request, Response } from "express";
import { isPredictionEnabled } from "../settings/prediction-setting";
import { listPredictions } from "../services/prediction/prediction.service";

export async function getPredictions(_req: Request, res: Response) {
  if (!isPredictionEnabled()) return res.status(200).json([]);
  return res.status(200).json(await listPredictions());
}
