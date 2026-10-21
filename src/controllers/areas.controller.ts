import { AREA_TITLES, knownAreaName } from "../constants/areas";
import { Area } from "../models/area.model";
import { areaHistory, HISTORY_DEFAULT_MINUTES } from "../services/area-history.service";
import { Request, Response } from "express";

export async function getAreas(_req: Request, res: Response) {
  // Only the known areas: a broken /areas answer must never reach the map
  const areas = await Area.find({ name: { $in: AREA_TITLES } }).lean();
  return res.status(200).json(areas);
}

/** One fox's status, hints, spots and hunts of the last `minutes` (default 180) for the Vossen card's history panel */
export async function getAreaHistory(req: Request, res: Response) {
  const area = knownAreaName(req.params.area);
  if (!area) return res.status(404).json({ message: "Onbekend deelgebied." });
  const minutes = req.query.minutes ? Number(req.query.minutes) : HISTORY_DEFAULT_MINUTES;
  const history = await areaHistory(area, minutes);
  if (!history) return res.status(404).json({ message: "Onbekend deelgebied." });
  return res.status(200).json(history);
}
