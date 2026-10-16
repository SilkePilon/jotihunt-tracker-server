import { HuntReport, type HuntReportRecord } from "../models/hunt-report.model";
import {
  effectiveHuntTime,
  fieldSource,
  huntReportStatus,
  needsReview,
  submitDeadline,
  type FieldSource,
  type HuntReportStatus,
  type OcrStatus,
} from "./hunt-report.helpers";

export interface DuplicateOf {
  id: string;
  reportedByName: string;
}

export interface HuntReportView {
  _id: string;
  area: string;
  huntCode: string | null;
  /** Effective time: the read/entered time, else the photo time, else the upload time */
  huntTime: string;
  huntTimeKnown: boolean;
  huntCodeSource: FieldSource | null;
  huntTimeSource: FieldSource | null;
  reportedBy: string;
  reportedByName: string;
  submittedAt: string | null;
  submittedByName: string | null;
  site: { status: string; points: number; seenAt: string } | null;
  createdAt: string;
  status: HuntReportStatus;
  deadline: string;
  /** False for hunts reported without a photo (QR flow): no OCR, confirmed on jotihunt.nl by scanning the fox's QR code */
  hasPhoto: boolean;
  /** null without a photo */
  photoUrl: string | null;
  /** Small list thumbnail; serves the full photo when the report has none. null without a photo */
  thumbUrl: string | null;
  ocrStatus: OcrStatus;
  ocrError: string | null;
  codeConfidence: number | null;
  timeConfidence: number | null;
  /** Sticker bounding box in the photo: [ymin, xmin, ymax, xmax], 0..1000; null when unknown */
  stickerBox: [number, number, number, number] | null;
  needsReview: boolean;
  duplicateOf: DuplicateOf | null;
}

/** The stored fields the view is built from: a hydrated document, or a lean object selected with VIEW_FIELDS. */
export type HuntReportViewSource = Pick<
  HuntReportRecord,
  "_id" | "area" | "huntCode" | "huntTime" | "takenAt" | "huntCodeSource" | "huntTimeSource" | "reportedBy" | "reportedByName" | "submittedAt" | "submittedByName" | "site" | "ocr" | "photo"
>;

/** Projection for lean queries feeding toHuntReportView (and compareAge) */
export const VIEW_FIELDS =
  "area photo huntCode huntTime takenAt huntCodeSource huntTimeSource reportedBy reportedByName submittedAt submittedByName site createdAt ocr.status ocr.error ocr.codeConfidence ocr.timeConfidence ocr.stickerBox";

/** Upload time (timestamps); a document getter or a lean field */
export function createdAtOf(report: object): Date {
  return (report as { createdAt: Date }).createdAt;
}

export function toHuntReportView(report: HuntReportViewSource, now: Date, duplicateOf: DuplicateOf | null = null): HuntReportView {
  const id = report._id.toString();
  const huntTime = effectiveHuntTime({ huntTime: report.huntTime, takenAt: report.takenAt, createdAt: createdAtOf(report) });
  const ocr = report.ocr ?? null;
  const hasPhoto = Boolean(report.photo);
  return {
    _id: id,
    area: report.area,
    huntCode: report.huntCode ?? null,
    huntTime: huntTime.toISOString(),
    huntTimeKnown: Boolean(report.huntTime),
    huntCodeSource: fieldSource(report.huntCode, report.huntCodeSource),
    huntTimeSource: fieldSource(report.huntTime, report.huntTimeSource),
    reportedBy: report.reportedBy.toString(),
    reportedByName: report.reportedByName,
    submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
    submittedByName: report.submittedByName ?? null,
    site: report.site ? { status: report.site.status, points: report.site.points, seenAt: report.site.seenAt.toISOString() } : null,
    createdAt: createdAtOf(report).toISOString(),
    status: huntReportStatus({ huntTime, submittedAt: report.submittedAt, site: report.site }, now),
    deadline: submitDeadline(huntTime).toISOString(),
    hasPhoto,
    photoUrl: hasPhoto ? `/hunt-reports/${id}/photo` : null,
    thumbUrl: hasPhoto ? `/hunt-reports/${id}/photo?size=thumb` : null,
    ocrStatus: (ocr?.status as OcrStatus | undefined) ?? "done",
    ocrError: ocr?.error ?? null,
    codeConfidence: ocr?.codeConfidence ?? null,
    timeConfidence: ocr?.timeConfidence ?? null,
    stickerBox: ocr?.stickerBox?.length === 4 ? ([...ocr.stickerBox] as HuntReportView["stickerBox"]) : null,
    // Nothing to check without a photo: no code or time is read
    needsReview: hasPhoto && needsReview(report),
    duplicateOf,
  };
}

/** Oldest first; the first report with a code is the original, later ones are duplicates. */
export function compareAge(a: Pick<HuntReportRecord, "_id">, b: Pick<HuntReportRecord, "_id">): number {
  return createdAtOf(a).getTime() - createdAtOf(b).getTime() || a._id.toString().localeCompare(b._id.toString());
}

/** The oldest other report with exactly the same code, when this report is not the oldest itself. */
export async function findDuplicateOf(report: Pick<HuntReportRecord, "_id" | "huntCode">): Promise<DuplicateOf | null> {
  if (!report.huntCode) return null;
  const [first] = (await HuntReport.find({ huntCode: report.huntCode }).select("_id reportedByName createdAt").lean()).sort(compareAge);
  if (!first || first._id.equals(report._id)) return null;
  return { id: first._id.toString(), reportedByName: first.reportedByName };
}
