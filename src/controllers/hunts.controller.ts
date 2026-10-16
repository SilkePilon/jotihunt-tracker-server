import { Request, Response } from "express";
import { sendCachedJson } from "../services/response-cache";
import { huntSyncStatus, listHuntSyncEvents, listSyncedHunts } from "../services/hunt-sync.view";

/** Polled by every hunter: one shared body for a moment (hunts are only written by the scraper cron) */
export async function getHunts(_req: Request, res: Response) {
  return sendCachedJson(res, "hunts", listSyncedHunts);
}

/** The sync with jotihunt.nl: state, counts and points (the Hunts card) */
export async function getHuntSync(_req: Request, res: Response) {
  return res.status(200).json(await huntSyncStatus());
}

/** The sync log, newest first; `before` (ISO) pages to older entries */
export async function getHuntEvents(req: Request, res: Response) {
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  const before = typeof req.query.before === "string" && req.query.before ? new Date(req.query.before) : null;
  return res.status(200).json(await listHuntSyncEvents({ limit, before }));
}
