import { Request, Response } from "express";
import { respond, ServiceError } from "../http/service-error";
import { getTelegramService, type TelegramService } from "../services/telegram.service";

/** Without a service (not wired up yet) the routes answer as if Telegram is off. */
function requireService(): TelegramService {
  const service = getTelegramService();
  if (!service) throw new ServiceError(503, "Telegram is niet ingesteld op de server.");
  return service;
}

export async function getStatus(_req: Request, res: Response) {
  return respond(res, 200, async () => (await getTelegramService()?.status()) ?? { state: "unavailable", connected: false });
}

export async function startLink(req: Request, res: Response) {
  return respond(res, 200, () => requireService().startLink(req.user!.name ?? null));
}

export async function submitPassword(req: Request, res: Response) {
  return respond(res, 200, () => requireService().submitPassword(String(req.body.password)));
}

export async function unlink(_req: Request, res: Response) {
  return respond(res, 204, () => requireService().unlink());
}

export async function listMessages(req: Request, res: Response) {
  const limit = typeof req.query.limit === "number" ? req.query.limit : Number(req.query.limit) || undefined;
  return respond(res, 200, async () => (await getTelegramService()?.listMessages(limit)) ?? { linked: false, connected: false, messages: [] });
}
