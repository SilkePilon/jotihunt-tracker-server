import { Request, Response } from "express";

// Demo mode is gone (replaced by editions); this route is removed in the editions boot rewiring (Task 6).
export function getDemo(_req: Request, res: Response) {
  return res.status(200).json({ enabled: false, enabledAt: null, startedAt: null });
}

export function postDemo(_req: Request, res: Response) {
  return res.status(410).json({ message: "Demomodus bestaat niet meer; gebruik Jotihunt-edities." });
}
