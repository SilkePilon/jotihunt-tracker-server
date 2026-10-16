import { Request, Response } from "express";
import { respond } from "../http/service-error";
import { getTelegramService, requireTelegramService } from "../services/telegram.service";

export async function getStatus(_req: Request, res: Response) {
  return respond(res, 200, async () => (await getTelegramService()?.status()) ?? { state: "unavailable", connected: false });
}

export async function startLink(req: Request, res: Response) {
  return respond(res, 200, () => requireTelegramService().startLink(req.user!.name ?? null));
}

export async function submitPassword(req: Request, res: Response) {
  return respond(res, 200, () => requireTelegramService().submitPassword(String(req.body.password)));
}

export async function unlink(_req: Request, res: Response) {
  return respond(res, 204, () => requireTelegramService().unlink());
}

export async function listMessages(req: Request, res: Response) {
  const limit = typeof req.query.limit === "number" ? req.query.limit : Number(req.query.limit) || undefined;
  return respond(res, 200, async () => (await getTelegramService()?.listMessages(limit)) ?? { linked: false, connected: false, messages: [] });
}
