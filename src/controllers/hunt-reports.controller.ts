import { Request, Response } from "express";
import type { HuntKind } from "../services/hunt-report.helpers";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  HuntReportError,
  listHuntReports,
  setHuntReportSubmitted,
} from "../services/hunt-report.service";

async function respond(res: Response, status: number, action: () => Promise<unknown>) {
  try {
    const result = await action();
    return status === 204 ? res.status(204).end() : res.status(status).json(result);
  } catch (error) {
    if (error instanceof HuntReportError) {
      return res.status(error.status).json({ message: error.message, ...error.details });
    }
    throw error;
  }
}

export function getHuntReports(_req: Request, res: Response) {
  return respond(res, 200, () => listHuntReports());
}

export function postHuntReport(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ message: "Foto ontbreekt of is geen JPEG, PNG of WebP." });
  const { area, huntCode, huntTime, kind, lng, lat } = req.body as Record<string, string | undefined>;
  const location: [number, number] | undefined = lng !== undefined && lat !== undefined ? [Number(lng), Number(lat)] : undefined;
  return respond(res, 201, () =>
    createHuntReport(
      { area: area!, huntCode: huntCode!, huntTime: new Date(huntTime!), kind: kind as HuntKind, photo: { buffer: req.file!.buffer, mimetype: req.file!.mimetype }, location },
      req.user!,
    ),
  );
}

export function putSubmitted(req: Request, res: Response) {
  return respond(res, 200, () => setHuntReportSubmitted(String(req.params.id), req.body.submitted === true, req.user!));
}

export function deleteReport(req: Request, res: Response) {
  return respond(res, 204, () => deleteHuntReport(String(req.params.id), req.user!));
}

export async function getPhoto(req: Request, res: Response) {
  try {
    const file = await huntReportPhotoPath(String(req.params.id));
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.sendFile(file);
  } catch (error) {
    if (error instanceof HuntReportError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
