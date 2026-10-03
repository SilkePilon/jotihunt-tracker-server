import { AREA_TITLES } from "../constants/areas";
import { Area } from "../models/area.model";
import { Request, Response } from "express";

export async function getAreas(_req: Request, res: Response) {
  // Only the known areas: a broken /areas answer must never reach the map
  const areas = await Area.find({ name: { $in: AREA_TITLES } });
  return res.status(200).json(areas);
}
