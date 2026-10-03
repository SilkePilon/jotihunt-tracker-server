import mongoose from "mongoose";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker, MarkerType } from "../models/marker.model";
import type { UserType } from "../models/user.model";
import { ServiceError } from "../http/service-error";
import { fieldSource, HUNT_AREAS, normalizeHuntCode, resolvePhotoExtension } from "./hunt-report.helpers";
import { compareAge, createdAtOf, findDuplicateOf, toHuntReportView, VIEW_FIELDS, type HuntReportView, type HuntReportViewSource } from "./hunt-report.view";
import { deletePhoto, photoFilePath, savePhoto, uploadsDir } from "./photo-store";
import { isDuplicateKeyError } from "../utils/mongo";

export type { DuplicateOf, HuntReportView } from "./hunt-report.view";

export interface NewHuntReport {
  area: string;
  /** Optional: normally read from the photo by OCR */
  huntCode?: string;
  /** Optional: normally read from the photo by OCR */
  huntTime?: Date;
  photo: { buffer: Buffer; mimetype: string };
  /** [lng, lat] of the phone at registration */
  location?: [number, number];
  /** Id the phone generated for this photo; the same id again returns the existing report */
  uploadId?: string;
}

async function viewOf(report: HuntReportDocument): Promise<HuntReportView> {
  return toHuntReportView(report, new Date(), await findDuplicateOf(report));
}

async function findReport(id: string): Promise<HuntReportDocument> {
  const report = mongoose.isValidObjectId(id) ? await HuntReport.findById(id) : null;
  if (!report) throw new ServiceError(404, "Hunt niet gevonden.");
  return report;
}

function toMinute(date: Date): Date {
  const time = new Date(date);
  time.setSeconds(0, 0);
  return time;
}

/** Save a loaded report; 404 when it was deleted meanwhile (a concurrent DELETE). */
async function saveReport(report: HuntReportDocument) {
  try {
    await report.save();
  } catch (error) {
    if (error instanceof mongoose.Error.DocumentNotFoundError) throw new ServiceError(404, "Hunt niet gevonden.");
    throw error;
  }
}

/**
 * Move the report's hunt marker to the report's effective time (the read/entered time, else the upload time), as
 * stored now. Re-checks the report afterwards, so the last of concurrent edits always leaves its own time on the marker.
 */
export async function syncHuntMarkerTime(reportId: mongoose.Types.ObjectId | string): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const report = await HuntReport.findById(reportId).select("markerId huntTime createdAt").lean();
    if (!report?.markerId) return;
    await Marker.updateOne({ _id: report.markerId }, { $set: { time: toMinute(report.huntTime ?? report.createdAt) } });
    const after = await HuntReport.findById(reportId).select("huntTime").lean();
    if (!after || (after.huntTime?.getTime() ?? null) === (report.huntTime?.getTime() ?? null)) return;
  }
}

/** The report an earlier attempt of the same upload (same phone-generated id, same user) already created. */
async function existingUpload(uploadId: string | undefined, user: UserType): Promise<HuntReportView | null> {
  if (!uploadId) return null;
  const existing = await HuntReport.findOne({ uploadId, reportedBy: user._id });
  return existing ? await viewOf(existing) : null;
}

/**
 * Store a new report. Code and time are optional (normally read from the photo by OCR); when one is missing the
 * report gets `ocr.status: "pending"` and the caller queues the reading. Duplicate codes are allowed (flagged in the view).
 */
export async function createHuntReport(input: NewHuntReport, user: UserType): Promise<HuntReportView> {
  const retried = await existingUpload(input.uploadId, user);
  if (retried) return retried;
  const huntCode = input.huntCode ? normalizeHuntCode(input.huntCode) || null : null;
  const huntTime = input.huntTime ? toMinute(input.huntTime) : null;
  const extension = resolvePhotoExtension(input.photo.mimetype);
  if (!extension) throw new ServiceError(400, "Foto moet een JPEG, PNG of WebP zijn.");

  let photo: string | null = null;
  let report: HuntReportDocument | null = null;
  // The report is stored before its marker, so a crash in between never leaves a hunt marker without a report
  const markerId = input.location ? new mongoose.Types.ObjectId() : undefined;

  try {
    photo = await savePhoto(input.photo.buffer, extension);
    report = await HuntReport.create({
      area: input.area as (typeof HUNT_AREAS)[number],
      huntCode,
      huntTime,
      huntCodeSource: huntCode ? "manual" : undefined,
      huntTimeSource: huntTime ? "manual" : undefined,
      photo,
      reportedBy: user._id,
      reportedByName: user.name,
      location: input.location ? { type: "Point", coordinates: input.location } : undefined,
      markerId,
      uploadId: input.uploadId,
      ocr: { status: huntCode && huntTime ? "done" : "pending", attempts: 0 },
    });
    if (markerId && input.location) {
      // Until the time is read the marker uses the upload time; the OCR queue moves it to the read time
      await Marker.create({
        _id: markerId,
        area: input.area,
        time: toMinute(huntTime ?? createdAtOf(report)),
        type: MarkerType.Hunt,
        location: { type: "Point", coordinates: input.location },
      });
    }
    return await viewOf(report);
  } catch (error) {
    // Clean up side effects
    if (report) await HuntReport.deleteOne({ _id: report._id }).catch(() => undefined);
    if (photo) await deletePhoto(photo).catch(() => undefined);
    // Two attempts of the same upload raced: return the one that won
    if (isDuplicateKeyError(error)) {
      const retried = await existingUpload(input.uploadId, user);
      if (retried) return retried;
    }
    throw error;
  }
}

export async function listHuntReports(now = new Date()): Promise<HuntReportView[]> {
  const reports: HuntReportViewSource[] = await HuntReport.find().select(VIEW_FIELDS).lean();
  const firstByCode = new Map<string, HuntReportViewSource>();
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
  if (!user.admin) throw new ServiceError(403, "Alleen admins kunnen hunts wijzigen.");
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
  await saveReport(report);
  return viewOf(report);
}

/** HQ corrects the code and/or time by hand; manual values are never overwritten by OCR. */
export async function setHuntReportFields(id: string, fields: { huntCode?: string; huntTime?: Date }, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  if (fields.huntCode === undefined && fields.huntTime === undefined) throw new ServiceError(400, "Geef een huntcode of tijd op.");
  const huntCode = fields.huntCode === undefined ? undefined : normalizeHuntCode(fields.huntCode);
  if (huntCode === "") throw new ServiceError(400, "Huntcode ontbreekt.");
  if (fields.huntTime !== undefined && Number.isNaN(fields.huntTime.getTime())) throw new ServiceError(400, "Ongeldige tijd.");
  const report = await findReport(id);
  if (huntCode !== undefined) {
    if (huntCode !== report.huntCode) {
      // The jotihunt.nl result belonged to the old code; always $unset, also one the scraper stored after this load
      report.site = undefined;
      report.markModified("site");
    }
    report.huntCode = huntCode;
    report.huntCodeSource = "manual";
  }
  if (fields.huntTime !== undefined) {
    report.huntTime = toMinute(fields.huntTime);
    report.huntTimeSource = "manual";
  }
  const bothManual = fieldSource(report.huntCode, report.huntCodeSource) === "manual" && fieldSource(report.huntTime, report.huntTimeSource) === "manual";
  if (bothManual && (report.ocr?.status === "pending" || report.ocr?.status === "reading")) report.set("ocr.status", "done");
  await saveReport(report);
  if (fields.huntTime !== undefined) await syncHuntMarkerTime(report._id);
  return viewOf(report);
}

/** Forget the OCR-read values (manual ones stay) and mark the report for a new reading; the caller queues it. */
/** Admin: let the AI read the photo again; the code and time are cleared (also values entered by hand). */
export async function requestHuntReportRead(id: string, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  const report = await findReport(id);
  report.huntCode = null;
  report.huntCodeSource = undefined;
  report.huntTime = null;
  report.huntTimeSource = undefined;
  report.set("ocr", { status: "pending", attempts: 0 });
  await saveReport(report);
  await syncHuntMarkerTime(report._id);
  return viewOf(report);
}

export async function deleteHuntReport(id: string, user: UserType): Promise<void> {
  requireAdmin(user);
  const report = await findReport(id);
  if (report.submittedAt) throw new ServiceError(409, "Deze hunt is al ingestuurd en kan niet meer verwijderd worden.");
  if (report.site) throw new ServiceError(409, "Deze hunt staat al op jotihunt.nl en kan niet meer verwijderd worden.");
  // Conditional: a report submitted or linked to jotihunt.nl since it was loaded above is never deleted
  const { deletedCount } = await HuntReport.deleteOne({ _id: report._id, submittedAt: null, site: null });
  if (deletedCount === 0) {
    const current = await HuntReport.findById(report._id).select("_id").lean();
    if (!current) throw new ServiceError(404, "Hunt niet gevonden.");
    throw new ServiceError(409, "Deze hunt is net ingestuurd of staat al op jotihunt.nl en kan niet meer verwijderd worden.");
  }
  if (report.markerId) await Marker.deleteOne({ _id: report.markerId });
  await deletePhoto(report.photo).catch(() => undefined);
}

export async function huntReportPhotoPath(id: string): Promise<string> {
  const report = await findReport(id);
  return photoFilePath(report.photo);
}

/** Photo files this old without a report are leftovers of a crash between storing the photo and the report. */
export const ORPHAN_PHOTO_AGE_MS = 60 * 60 * 1000;

/**
 * Remove photo files of the current mode's uploads directory that no report refers to and that are older than
 * ORPHAN_PHOTO_AGE_MS (an upload in progress stores its report within moments). Never runs on a database without
 * reports (fresh or restored: its photos may belong to reports that are not there yet). Returns how many were removed.
 */
export async function removeOrphanPhotos(now = Date.now()): Promise<number> {
  const dir = uploadsDir();
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (files.length === 0) return 0;
  const referenced = new Set<string>(await HuntReport.distinct("photo"));
  if (referenced.size === 0) return 0;
  let removed = 0;
  for (const name of files) {
    if (referenced.has(name)) continue;
    const { mtimeMs } = await stat(path.join(dir, name));
    if (now - mtimeMs < ORPHAN_PHOTO_AGE_MS) continue;
    await deletePhoto(name);
    removed++;
  }
  return removed;
}
