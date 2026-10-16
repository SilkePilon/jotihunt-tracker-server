import { Request, Response } from "express";
import { respond, ServiceError } from "../http/service-error";
import { BuildingsUpstreamError } from "../services/buildings.client";
import { isValidTile, TILE_ZOOM } from "../services/buildings.helpers";
import { requireBuildingsService } from "../services/buildings.service";

/** Vector tile bytes; MapLibre loads it with the Authorization header (the client's jhbuildings:// custom protocol fetches it). */
export async function getTile(req: Request, res: Response) {
  const tile = { x: Number(req.params.x), y: Number(req.params.y) };
  if (Number(req.params.z) !== TILE_ZOOM || !isValidTile(tile)) return res.status(400).json({ message: "Ongeldige tegel." });
  try {
    const mvt = await requireBuildingsService().getTile(tile);
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (!mvt) return res.status(204).end();
    res.setHeader("Content-Type", "application/x-protobuf");
    return res.status(200).send(mvt);
  } catch (error) {
    if (error instanceof ServiceError) return res.status(error.status).json({ message: error.message });
    if (error instanceof BuildingsUpstreamError) return res.status(502).json({ message: "3DBAG is nu niet bereikbaar." });
    throw error;
  }
}

export async function getStatus(_req: Request, res: Response) {
  return respond(res, 200, () => requireBuildingsService().status());
}

export async function refresh(_req: Request, res: Response) {
  return respond(res, 202, () => requireBuildingsService().startRefresh());
}

export async function prefetch(req: Request, res: Response) {
  return respond(res, 202, () => requireBuildingsService().startPrefetch(Number(req.body.lat), Number(req.body.lon), Number(req.body.radiusKm)));
}

export async function clear(_req: Request, res: Response) {
  return respond(res, 200, () => requireBuildingsService().clear());
}
