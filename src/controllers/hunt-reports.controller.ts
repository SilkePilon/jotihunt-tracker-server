import { Request, Response } from "express";
import { existsSync } from "node:fs";
import { respond, ServiceError } from "../http/service-error";
import { huntOcr } from "../services/hunt-ocr.instance";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  type HuntReportView,
  listHuntReports,
  requestHuntReportRead,
  setHuntReportFields,
  setHuntReportSubmitted,
} from "../services/hunt-report.service";

function queueReading(view: HuntReportView): HuntReportView {
  if (view.ocrStatus === "pending") huntOcr.enqueue(view._id);
  return view;
}

export function getHuntReports(_req: Request, res: Response) {
  return respond(res, 200, () => listHuntReports());
}

export function postHuntReport(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ message: "Foto ontbreekt of is geen JPEG, PNG of WebP." });
  const { area, huntCode, huntTime, lng, lat, uploadId } = req.body as Record<string, string | undefined>;
  const location: [number, number] | undefined = lng !== undefined && lat !== undefined ? [Number(lng), Number(lat)] : undefined;
  return respond(res, 201, async () =>
    queueReading(
      await createHuntReport(
        {
          area: area!,
          huntCode: huntCode || undefined,
          huntTime: huntTime ? new Date(huntTime) : undefined,
          photo: { buffer: req.file!.buffer, mimetype: req.file!.mimetype },
          location,
          uploadId: uploadId || undefined,
        },
        req.user!,
      ),
    ),
  );
}

export function patchReport(req: Request, res: Response) {
  const { huntCode, huntTime } = req.body as { huntCode?: string; huntTime?: string };
  return respond(res, 200, () => setHuntReportFields(String(req.params.id), { huntCode, huntTime: huntTime === undefined ? undefined : new Date(huntTime) }, req.user!));
}

export function postRead(req: Request, res: Response) {
  return respond(res, 200, async () => queueReading(await requestHuntReportRead(String(req.params.id), req.user!)));
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
    if (!existsSync(file)) return res.status(404).json({ message: "Foto niet gevonden." });
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.sendFile(file);
  } catch (error) {
    if (error instanceof ServiceError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
