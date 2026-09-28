import mongoose from "mongoose";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker, MarkerType, type MarkerDocument } from "../models/marker.model";
import type { UserType } from "../models/user.model";
import {
  effectiveHuntTime,
  fieldSource,
  HUNT_AREAS,
  huntReportStatus,
  needsReview,
  normalizeHuntCode,
  resolvePhotoExtension,
  submitDeadline,
  type FieldSource,
  type HuntKind,
  type HuntReportStatus,
  type OcrStatus,
} from "./hunt-report.helpers";
import { deletePhoto, photoFilePath, savePhoto } from "./photo-store";

export class HuntReportError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface NewHuntReport {
  area: string;
  /** Optional: normally read from the photo by OCR */
  huntCode?: string;
  /** Optional: normally read from the photo by OCR */
  huntTime?: Date;
  kind: HuntKind;
  photo: { buffer: Buffer; mimetype: string };
  /** [lng, lat] of the phone at registration */
  location?: [number, number];
  /** Id the phone generated for this photo; the same id again returns the existing report */
  uploadId?: string;
}

export interface DuplicateOf {
  id: string;
  reportedByName: string;
}

export interface HuntReportView {
  _id: string;
  area: string;
  huntCode: string | null;
  /** Effective time: the read/entered time, else the upload time */
  huntTime: string;
  huntTimeKnown: boolean;
  huntCodeSource: FieldSource | null;
  huntTimeSource: FieldSource | null;
  kind: HuntKind;
  reportedBy: string;
  reportedByName: string;
  submittedAt: string | null;
  submittedByName: string | null;
  site: { status: string; points: number; seenAt: string } | null;
  createdAt: string;
  status: HuntReportStatus;
  deadline: string;
  photoUrl: string;
  ocrStatus: OcrStatus;
  ocrError: string | null;
  codeConfidence: number | null;
  timeConfidence: number | null;
  needsReview: boolean;
  duplicateOf: DuplicateOf | null;
}

function createdAtOf(report: HuntReportDocument): Date {
  return report.get("createdAt") as Date;
}

export function toHuntReportView(report: HuntReportDocument, now: Date, duplicateOf: DuplicateOf | null = null): HuntReportView {
  const id = report._id.toString();
  const huntTime = effectiveHuntTime({ huntTime: report.huntTime, createdAt: createdAtOf(report) });
  const ocr = report.ocr ?? null;
  return {
    _id: id,
    area: report.area,
    huntCode: report.huntCode ?? null,
    huntTime: huntTime.toISOString(),
    huntTimeKnown: Boolean(report.huntTime),
    huntCodeSource: fieldSource(report.huntCode, report.huntCodeSource),
    huntTimeSource: fieldSource(report.huntTime, report.huntTimeSource),
    kind: report.kind as HuntKind,
    reportedBy: report.reportedBy.toString(),
    reportedByName: report.reportedByName,
    submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
    submittedByName: report.submittedByName ?? null,
    site: report.site ? { status: report.site.status, points: report.site.points, seenAt: report.site.seenAt.toISOString() } : null,
    createdAt: createdAtOf(report).toISOString(),
    status: huntReportStatus({ huntTime, submittedAt: report.submittedAt, site: report.site }, now),
    deadline: submitDeadline(huntTime).toISOString(),
    photoUrl: `/hunt-reports/${id}/photo`,
    ocrStatus: (ocr?.status as OcrStatus | undefined) ?? "done",
    ocrError: ocr?.error ?? null,
    codeConfidence: ocr?.codeConfidence ?? null,
    timeConfidence: ocr?.timeConfidence ?? null,
    needsReview: needsReview(report),
    duplicateOf,
  };
}

/** Oldest first; the first report with a code is the original, later ones are duplicates. */
function compareAge(a: HuntReportDocument, b: HuntReportDocument): number {
  return createdAtOf(a).getTime() - createdAtOf(b).getTime() || a._id.toString().localeCompare(b._id.toString());
}

/** The oldest other report with exactly the same code, when this report is not the oldest itself. */
async function findDuplicateOf(report: HuntReportDocument): Promise<DuplicateOf | null> {
  if (!report.huntCode) return null;
  const [first] = (await HuntReport.find({ huntCode: report.huntCode })).sort(compareAge);
  if (!first || first._id.equals(report._id)) return null;
  return { id: first._id.toString(), reportedByName: first.reportedByName };
}

async function viewOf(report: HuntReportDocument): Promise<HuntReportView> {
  return toHuntReportView(report, new Date(), await findDuplicateOf(report));
}

async function findReport(id: string): Promise<HuntReportDocument> {
  const report = mongoose.isValidObjectId(id) ? await HuntReport.findById(id) : null;
  if (!report) throw new HuntReportError(404, "Hunt niet gevonden.");
  return report;
}

function toMinute(date: Date): Date {
  const time = new Date(date);
  time.setSeconds(0, 0);
  return time;
}

/**
 * Store a new report. Code and time are optional (normally read from the photo by OCR); when one is missing the
 * report gets `ocr.status: "pending"` and the caller queues the reading. Duplicate codes are allowed (flagged in the view).
 */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

/** The report an earlier attempt of the same upload (same phone-generated id, same user) already created. */
async function existingUpload(uploadId: string | undefined, user: UserType): Promise<HuntReportView | null> {
  if (!uploadId) return null;
  const existing = await HuntReport.findOne({ uploadId, reportedBy: user._id });
  return existing ? await viewOf(existing) : null;
}

export async function createHuntReport(input: NewHuntReport, user: UserType): Promise<HuntReportView> {
  const retried = await existingUpload(input.uploadId, user);
  if (retried) return retried;
  const huntCode = input.huntCode ? normalizeHuntCode(input.huntCode) || null : null;
  const huntTime = input.huntTime ? toMinute(input.huntTime) : null;
  const extension = resolvePhotoExtension(input.photo.mimetype);
  if (!extension) throw new HuntReportError(400, "Foto moet een JPEG, PNG of WebP zijn.");

  let photo: string | null = null;
  let marker: MarkerDocument | null = null;

  try {
    photo = await savePhoto(input.photo.buffer, extension);
    // Until the time is read the marker uses the upload time; the OCR queue moves it to the read time
    marker = input.location
      ? await Marker.create({ area: input.area, time: huntTime ?? toMinute(new Date()), type: MarkerType.Hunt, location: { type: "Point", coordinates: input.location } })
      : null;

    const report = await HuntReport.create({
      area: input.area as (typeof HUNT_AREAS)[number],
      huntCode,
      huntTime,
      huntCodeSource: huntCode ? "manual" : undefined,
      huntTimeSource: huntTime ? "manual" : undefined,
      kind: input.kind,
      photo,
      reportedBy: user._id,
      reportedByName: user.name,
      location: input.location ? { type: "Point", coordinates: input.location } : undefined,
      markerId: marker?._id,
      uploadId: input.uploadId,
      ocr: { status: huntCode && huntTime ? "done" : "pending", attempts: 0 },
    });
    return await viewOf(report);
  } catch (error) {
    // Clean up side effects
    if (photo) await deletePhoto(photo);
    if (marker) await Marker.deleteOne({ _id: marker._id });
    // Two attempts of the same upload raced: return the one that won
    if (isDuplicateKeyError(error)) {
      const retried = await existingUpload(input.uploadId, user);
      if (retried) return retried;
    }
    throw error;
  }
}

export async function listHuntReports(now = new Date()): Promise<HuntReportView[]> {
  const reports = await HuntReport.find();
  const firstByCode = new Map<string, HuntReportDocument>();
  for (const report of [...reports].sort(compareAge)) {
    if (report.huntCode && !firstByCode.has(report.huntCode)) firstByCode.set(report.huntCode, report);
  }
  return reports
    .map((report) => {
      const first = report.huntCode ? firstByCode.get(report.huntCode) : undefined;
      const duplicateOf = first && !first._id.equals(report._id) ? { id: first._id.toString(), reportedByName: first.reportedByName } : null;
      return toHuntReportView(report, now, duplicateOf);
    })
    .sort((a, b) => b.huntTime.localeCompare(a.huntTime));
}

/** Hunt statuses, corrections and deletions are HQ work: admins only. */
function requireAdmin(user: UserType) {
  if (!user.admin) throw new HuntReportError(403, "Alleen admins kunnen hunts wijzigen.");
}

export async function setHuntReportSubmitted(id: string, submitted: boolean, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  const report = await findReport(id);
  if (submitted) {
    report.submittedAt = new Date();
    report.submittedBy = user._id;
    report.submittedByName = user.name;
  } else {
    report.submittedAt = undefined;
    report.submittedBy = undefined;
    report.submittedByName = undefined;
  }
  await report.save();
  return viewOf(report);
}

/** HQ corrects the code and/or time by hand; manual values are never overwritten by OCR. */
export async function setHuntReportFields(id: string, fields: { huntCode?: string; huntTime?: Date }, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  if (fields.huntCode === undefined && fields.huntTime === undefined) throw new HuntReportError(400, "Geef een huntcode of tijd op.");
  const huntCode = fields.huntCode === undefined ? undefined : normalizeHuntCode(fields.huntCode);
  if (huntCode === "") throw new HuntReportError(400, "Huntcode ontbreekt.");
  if (fields.huntTime !== undefined && Number.isNaN(fields.huntTime.getTime())) throw new HuntReportError(400, "Ongeldige tijd.");
  const report = await findReport(id);
  if (huntCode !== undefined) {
    // The jotihunt.nl result belonged to the old code
    if (huntCode !== report.huntCode) report.site = undefined;
    report.huntCode = huntCode;
    report.huntCodeSource = "manual";
  }
  if (fields.huntTime !== undefined) {
    report.huntTime = toMinute(fields.huntTime);
    report.huntTimeSource = "manual";
  }
  const bothManual = fieldSource(report.huntCode, report.huntCodeSource) === "manual" && fieldSource(report.huntTime, report.huntTimeSource) === "manual";
  if (bothManual && (report.ocr?.status === "pending" || report.ocr?.status === "reading")) report.set("ocr.status", "done");
  await report.save();
  if (fields.huntTime !== undefined && report.markerId) await Marker.updateOne({ _id: report.markerId }, { $set: { time: report.huntTime } });
  return viewOf(report);
}

/** Forget the OCR-read values (manual ones stay) and mark the report for a new reading; the caller queues it. */
export async function requestHuntReportRead(id: string, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  const report = await findReport(id);
  let resetMarker = false;
  if (fieldSource(report.huntCode, report.huntCodeSource) !== "manual") {
    report.huntCode = null;
    report.huntCodeSource = undefined;
  }
  if (fieldSource(report.huntTime, report.huntTimeSource) !== "manual") {
    report.huntTime = null;
    report.huntTimeSource = undefined;
    resetMarker = true;
  }
  report.set("ocr", { status: "pending", attempts: 0 });
  await report.save();
  if (resetMarker && report.markerId) await Marker.updateOne({ _id: report.markerId }, { $set: { time: toMinute(createdAtOf(report)) } });
  return viewOf(report);
}

export async function deleteHuntReport(id: string, user: UserType): Promise<void> {
  requireAdmin(user);
  const report = await findReport(id);
  if (report.submittedAt) throw new HuntReportError(409, "Deze hunt is al ingestuurd en kan niet meer verwijderd worden.");
  if (report.site) throw new HuntReportError(409, "Deze hunt staat al op jotihunt.nl en kan niet meer verwijderd worden.");
  await HuntReport.deleteOne({ _id: report._id });
  if (report.markerId) await Marker.deleteOne({ _id: report.markerId });
  await deletePhoto(report.photo).catch(() => undefined);
}

export async function huntReportPhotoPath(id: string): Promise<string> {
  const report = await findReport(id);
  return photoFilePath(report.photo);
}

/**
 * Copy the status and points of scraped jotihunt.nl hunts to the report with the same normalised code (the oldest
 * one when a code was reported twice; reports without a code can't link). Returns how many reports were updated.
 */
export async function linkScrapedHunts(hunts: { huntCode: string | null; status: string | null; points: number }[], now = new Date()): Promise<number> {
  let updated = 0;
  for (const hunt of hunts) {
    if (!hunt.huntCode) continue;
    const huntCode = normalizeHuntCode(hunt.huntCode);
    if (!huntCode) continue;
    const [first] = (await HuntReport.find({ huntCode })).sort(compareAge);
    if (!first) continue;
    const result = await HuntReport.updateOne(
      { _id: first._id },
      { $set: { site: { status: (hunt.status ?? "").trim(), points: Number.isFinite(hunt.points) ? hunt.points : 0, seenAt: now } } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}
