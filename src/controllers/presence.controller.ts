import { Request, Response } from "express";
import { presence } from "../services/presence.service";

/** Heartbeat of the hints page; answers who is on which item right now (the caller included) */
export function beat(req: Request, res: Response) {
  const area = typeof req.body.area === "string" ? req.body.area.toLowerCase() : undefined;
  presence.beat({ _id: String(req.user!._id), name: req.user!.name }, Number(req.body.itemId), area);
  return res.status(200).json(presence.list());
}

/** The caller closed the item (or the page): stop listing them at once */
export function leave(req: Request, res: Response) {
  presence.leave(String(req.user!._id));
  return res.status(204).end();
}
