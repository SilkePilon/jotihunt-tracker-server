import type { Request, Response } from "express";
import { sendPreparedJson } from "../services/response-cache";
import { reachService } from "../services/routes/instance";

/** Every fox's reachable area since its last spot (memoised, serialised once). */
export async function getReach(req: Request, res: Response) {
  const body = await reachService.reachJson();
  return sendPreparedJson(req, res, "reach", body);
}
