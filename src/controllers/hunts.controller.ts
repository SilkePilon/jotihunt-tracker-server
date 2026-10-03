import { Hunt } from "../models/hunt.model";
import { Request, Response } from "express";
import { sendCachedJson } from "../services/response-cache";

/** Polled by every hunter: one shared body for a moment (hunts are only written by the scraper cron) */
export async function getHunts(_req: Request, res: Response) {
  return sendCachedJson(res, "hunts", () => Hunt.find().sort({ updatedAt: -1 }).lean());
}
