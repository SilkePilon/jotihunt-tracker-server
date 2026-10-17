import { Request, Response } from "express";
import { scoreView } from "../services/score-sync.service";

/** Our provisional score from the jotihunt.nl dashboard (the Punten card) */
export async function getScore(_req: Request, res: Response) {
  return res.status(200).json(await scoreView());
}
