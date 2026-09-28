import axios from "axios";
import { Request, Response } from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { logger } from "..";
import { createGeminiClient, DEFAULT_GEMINI_MODEL, GeminiError } from "../services/gemini.client";
import { createHuntOcr } from "../services/hunt-ocr.service";
import type { HuntKind } from "../services/hunt-report.helpers";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  HuntReportError,
  type HuntReportView,
  listHuntReports,
  requestHuntReportRead,
  setHuntReportFields,
  setHuntReportSubmitted,
} from "../services/hunt-report.service";
import { photoFilePath } from "../services/photo-store";

/** Only the error class and our own message: never the raw error (an axios error holds the API key header). */
function describeOcrError(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error) return `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`;
  return "unknown error";
}

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

/** Background reading of hunt codes and times; without GEMINI_API_KEY every reading fails with a clear message. */
export const huntOcr = createHuntOcr({
  reader: geminiApiKey ? createGeminiClient({ apiKey: geminiApiKey, model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL, http: axios.create() }) : null,
  loadPhoto: (name) => readFile(photoFilePath(name)),
  onError: (error, reportId) => logger.warn(`OCR of hunt report ${reportId} failed: ${describeOcrError(error)}`),
});

function queueReading(view: HuntReportView): HuntReportView {
  if (view.ocrStatus === "pending") huntOcr.enqueue(view._id);
  return view;
}

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
  const { area, huntCode, huntTime, kind, lng, lat, uploadId } = req.body as Record<string, string | undefined>;
  const location: [number, number] | undefined = lng !== undefined && lat !== undefined ? [Number(lng), Number(lat)] : undefined;
  return respond(res, 201, async () =>
    queueReading(
      await createHuntReport(
        {
          area: area!,
          huntCode: huntCode || undefined,
          huntTime: huntTime ? new Date(huntTime) : undefined,
          kind: kind as HuntKind,
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
    if (error instanceof HuntReportError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
