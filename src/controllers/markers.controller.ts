import { Request, Response } from "express";
import { matchedData } from "express-validator";
import { logger } from "../logger";
import { Marker, MarkerType } from "../models/marker.model";
import { HintCell } from "../models/hint-cell.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { sendCachedJson } from "../services/response-cache";
import { takeOverImportedHintMarker } from "../services/hint-board.service";
import { forgetDeletedMarker } from "../services/jotiboard.import";
import { dismissHuntLocation, HUNT_MARKER_SOURCE } from "../services/hunt-sync.service";

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

  const create = () => Marker.create({ area, time: parsedTime, location: { type: "Point", coordinates: location.coordinates }, type });
  try {
    let marker;
    try {
      marker = await create();
    } catch (error) {
      // Our marker wins over a hint pin imported from Jotiboard on the same hour: take its place, try once more
      if (!isDuplicateKeyError(error) || type != MarkerType.Hint || !(await takeOverImportedHintMarker(area, parsedTime))) throw error;
      marker = await create();
    }
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

  // Solved hint cells link to their marker; drop the dangling links
  await HintCell.updateMany({ markerId: marker._id }, { $unset: { markerId: 1 } });
  // A deleted Jotiboard marker was wrong: the next sync must not import its pin again
  if (marker.source === "jotiboard") await forgetDeletedMarker(marker._id);
  // A deleted hunt marker had a wrong location: the hunt sync must not put it back
  if (marker.source === HUNT_MARKER_SOURCE && marker.externalId) await dismissHuntLocation(marker.externalId);
  return res.status(200).json(marker);
}
