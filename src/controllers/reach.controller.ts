import type { Request, Response } from "express";
import { reachService } from "../services/routes/instance";

/** Every fox's reachable area since its last spot (memoised, serialised once). */
export async function getReach(_req: Request, res: Response) {
  const body = await reachService.reachJson();
  return res.status(200).set("Content-Type", "application/json; charset=utf-8").send(body);
}
