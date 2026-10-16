import { Request, Response } from "express";
import { respond } from "../http/service-error";
import { getJotiboardService, requireJotiboardService } from "../services/jotiboard.service";

export async function getStatus(_req: Request, res: Response) {
  return respond(res, 200, async () => (await getJotiboardService()?.status()) ?? { state: "unavailable" });
}

export async function link(req: Request, res: Response) {
  return respond(res, 200, () => requireJotiboardService().link(String(req.body.username), String(req.body.password), req.user!.name ?? null));
}

export async function unlink(_req: Request, res: Response) {
  return respond(res, 200, () => requireJotiboardService().unlink());
}

export async function setSync(req: Request, res: Response) {
  return respond(res, 200, () => requireJotiboardService().setSyncEnabled(req.body.syncEnabled === true));
}

export async function purge(_req: Request, res: Response) {
  return respond(res, 200, () => requireJotiboardService().purge());
}
