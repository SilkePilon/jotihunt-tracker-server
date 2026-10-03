import { Request, Response } from "express";
import { matchedData } from "express-validator";
import { logger } from "../logger";
import { Marker, MarkerType } from "../models/marker.model";
import { HuntReport } from "../models/hunt-report.model";
import { HintCell } from "../models/hint-cell.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { sendCachedJson } from "../services/response-cache";

/** Polled by every hunter: one shared body for a moment (cleared by every marker write) */
export async function getMarkers(_req: Request, res: Response) {
  return sendCachedJson(res, "markers", () => Marker.find().lean());
}

/** Body is validated by markers.route.ts */
export async function createMarker(req: Request, res: Response) {
  const { area, location, time, type } = matchedData(req) as { area: string; location: { coordinates: [number, number] }; time: Date; type: MarkerType };
  const parsedTime = new Date(time);

  if (type == MarkerType.Hint) {
    // Hint markers are keyed by hour slot (see HintCell.slotTime / the unique index), so
    // round down to the exact hour, matching floorToHour in article-sync.service.
    parsedTime.setUTCMinutes(0, 0, 0);
  } else {
    parsedTime.setSeconds(0, 0);
  }

  try {
    const marker = await Marker.create({
      area,
      time: parsedTime,
      location: { type: "Point", coordinates: location.coordinates },
      type,
    });
    return res.status(201).json(marker);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ message: "Er bestaat al een hint-marker voor dit deelgebied op dit uur" });
    }
    logger.error("Error creating marker", error);
    return res.status(500).json({ message: "Error creating marker" });
  }
}

export async function deleteMarker(req: Request, res: Response) {
  const marker = await Marker.findByIdAndDelete(req.params.id);
  if (!marker) return res.status(404).json({ message: "Marker not found" });

  // Hunt reports and solved hint cells link to their marker; drop the dangling links
  await Promise.all([
    HuntReport.updateMany({ markerId: marker._id }, { $unset: { markerId: 1 } }),
    HintCell.updateMany({ markerId: marker._id }, { $unset: { markerId: 1 } }),
  ]);
  return res.status(200).json(marker);
}
