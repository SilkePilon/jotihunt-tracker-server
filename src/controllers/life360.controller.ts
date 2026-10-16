import { Request, Response } from "express";
import { respond, ServiceError } from "../http/service-error";
import { getLife360Service, requireLife360Service } from "../services/life360.service";

export async function getStatus(_req: Request, res: Response) {
  return respond(res, 200, async () => getLife360Service()?.status() ?? { state: "unavailable" });
}

export async function sendCode(req: Request, res: Response) {
  return respond(res, 200, () => requireLife360Service().sendCode(String(req.body.email)));
}

export async function verifyCode(req: Request, res: Response) {
  return respond(res, 200, () => requireLife360Service().verifyCode(String(req.body.code), req.user!.name ?? null));
}

export async function chooseCircle(req: Request, res: Response) {
  return respond(res, 200, () => requireLife360Service().chooseCircle(String(req.body.circleId), req.user!.name ?? null));
}

export async function pasteToken(req: Request, res: Response) {
  return respond(res, 200, () => requireLife360Service().pasteToken(String(req.body.token), req.user!.name ?? null));
}

export async function refresh(_req: Request, res: Response) {
  return respond(res, 202, () => requireLife360Service().refresh());
}

export async function unlink(_req: Request, res: Response) {
  return respond(res, 200, () => requireLife360Service().unlink());
}

export async function getMembers(_req: Request, res: Response) {
  return respond(res, 200, async () => getLife360Service()?.members() ?? { linked: false, stale: false, members: [] });
}

/** Image bytes; the client fetches it with the Authorization header (like hunt photos) and builds a blob URL. */
export async function getAvatar(req: Request, res: Response) {
  try {
    const service = getLife360Service();
    if (!service) throw new ServiceError(404, "Geen foto.");
    const image = await service.avatar(String(req.params.memberId));
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(image.body);
  } catch (error) {
    if (error instanceof ServiceError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
