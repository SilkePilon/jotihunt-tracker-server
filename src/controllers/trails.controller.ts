import type { Request, Response } from "express";
import { sendPreparedJson } from "../services/response-cache";
import { Marker } from "../models/marker.model";
import { trailsService } from "../services/routes/instance";

export async function getTrails(req: Request, res: Response) {
  // Serialised once per memo, like the cached list endpoints
  const body = await trailsService.trailsJson();
  return sendPreparedJson(req, res, "trails", body);
}

export async function setLegMode(req: Request, res: Response) {
  const legMode: "walk" | "car" | null = req.body.legMode ?? null;
  const update = legMode ? { $set: { legMode } } : { $unset: { legMode: 1 } };
  const marker = await Marker.findByIdAndUpdate(req.params.markerId, update, { returnDocument: "after" }).select("legMode").lean();
  if (!marker) return res.status(404).json({ message: "Marker niet gevonden." });
  trailsService.invalidate();
  return res.status(200).json({ _id: String(marker._id), legMode: marker.legMode ?? null });
}
