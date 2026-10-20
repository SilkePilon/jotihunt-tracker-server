import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logger } from "../logger";
import { createEdition, getControlStore, getRegistry, showEdition } from "./database-switch";
import { isArchive, type EditionsDoc } from "./registry";

/** Hunt and point counts per edition change slowly; cached a minute so the 30 s polling stays cheap. */
const COUNTS_TTL_MS = 60_000;
const counts = new Map<string, { at: number; hunts: number; points: number | null }>();

async function countsOf(dbName: string) {
  const cached = counts.get(dbName);
  if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached;
  const db = getControlStore().connection.useDb(dbName, { useCache: true });
  const [hunts, score] = await Promise.all([db.collection("hunts").countDocuments(), db.collection("sitescores").findOne({ key: "score" })]);
  const next = { at: Date.now(), hunts, points: typeof score?.total === "number" ? score.total : null };
  counts.set(dbName, next);
  return next;
}

export async function editionsView(registry: EditionsDoc = getRegistry()) {
  const editions = await Promise.all(
    [...registry.editions]
      .sort((a, b) => b.year - a.year)
      .map(async (edition) => {
        const { hunts, points } = await countsOf(edition.dbName);
        return { year: edition.year, live: edition.year === registry.liveYear, shown: edition.year === registry.shownYear, huntStart: edition.huntStart, huntEnd: edition.huntEnd, hunts, points };
      }),
  );
  return { editions, liveYear: registry.liveYear, shownYear: registry.shownYear, readOnly: isArchive(registry) };
}

export async function getEditions(_req: Request, res: Response) {
  return res.status(200).json(await editionsView());
}

export async function postEdition(req: Request, res: Response) {
  logger.info(`New edition requested by user ${req.user?._id}`);
  // SwitchBusyError / EditionRequestError carry a status; the global error handler maps them
  const registry = await createEdition();
  counts.clear();
  return res.status(200).json(await editionsView(registry));
}

export async function postShowEdition(req: Request, res: Response) {
  const year = Number(req.body.year);
  logger.info(`Show edition ${year} requested by user ${req.user?._id} (db ${mongoose.connection.name})`);
  return res.status(200).json(await editionsView(await showEdition(year)));
}
