import mongoose from "mongoose";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker, MarkerType, type MarkerDocument } from "../models/marker.model";
import type { UserType } from "../models/user.model";
import { ServiceError } from "../http/service-error";
import { fieldSource, HUNT_AREAS, normalizeHuntCode, resolvePhotoExtension } from "./hunt-report.helpers";
import { compareAge, createdAtOf, findDuplicateOf, toHuntReportView, type HuntReportView } from "./hunt-report.view";
import { deletePhoto, photoFilePath, savePhoto } from "./photo-store";
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
    if (photo) await deletePhoto(photo).catch(() => undefined);
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
  await report.save();
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
/** Admin: let the AI read the photo again; the code and time are cleared (also values entered by hand). */
export async function requestHuntReportRead(id: string, user: UserType): Promise<HuntReportView> {
  requireAdmin(user);
  const report = await findReport(id);
  report.huntCode = null;
  report.huntCodeSource = undefined;
  report.huntTime = null;
  report.huntTimeSource = undefined;
  report.set("ocr", { status: "pending", attempts: 0 });
  await report.save();
  if (report.markerId) await Marker.updateOne({ _id: report.markerId }, { $set: { time: toMinute(createdAtOf(report)) } });
  return viewOf(report);
}

export async function deleteHuntReport(id: string, user: UserType): Promise<void> {
  requireAdmin(user);
  const report = await findReport(id);
  if (report.submittedAt) throw new ServiceError(409, "Deze hunt is al ingestuurd en kan niet meer verwijderd worden.");
  if (report.site) throw new ServiceError(409, "Deze hunt staat al op jotihunt.nl en kan niet meer verwijderd worden.");
  await HuntReport.deleteOne({ _id: report._id });
  if (report.markerId) await Marker.deleteOne({ _id: report.markerId });
  await deletePhoto(report.photo).catch(() => undefined);
}

export async function huntReportPhotoPath(id: string): Promise<string> {
  const report = await findReport(id);
  return photoFilePath(report.photo);
}
