import mongoose from "mongoose";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker, MarkerType, type MarkerDocument } from "../models/marker.model";
import type { UserType } from "../models/user.model";
import { HUNT_AREAS, huntReportStatus, normalizeHuntCode, resolvePhotoExtension, submitDeadline, type HuntKind, type HuntReportStatus } from "./hunt-report.helpers";
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
  huntCode: string;
  huntTime: Date;
  kind: HuntKind;
  photo: { buffer: Buffer; mimetype: string };
  /** [lng, lat] of the phone at registration */
  location?: [number, number];
}

export interface HuntReportView {
  _id: string;
  area: string;
  huntCode: string;
  huntTime: string;
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
}

export function toHuntReportView(report: HuntReportDocument, now: Date): HuntReportView {
  const id = report._id.toString();
  return {
    _id: id,
    area: report.area,
    huntCode: report.huntCode,
    huntTime: report.huntTime.toISOString(),
    kind: report.kind as HuntKind,
    reportedBy: report.reportedBy.toString(),
    reportedByName: report.reportedByName,
    submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
    submittedByName: report.submittedByName ?? null,
    site: report.site ? { status: report.site.status, points: report.site.points, seenAt: report.site.seenAt.toISOString() } : null,
    createdAt: (report.get("createdAt") as Date).toISOString(),
    status: huntReportStatus(report, now),
    deadline: submitDeadline(report.huntTime).toISOString(),
    photoUrl: `/hunt-reports/${id}/photo`,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

async function duplicateError(huntCode: string): Promise<HuntReportError> {
  const existing = await HuntReport.findOne({ huntCode });
  return new HuntReportError(409, "Deze code is al geregistreerd.", { reason: "duplicate", reportedByName: existing?.reportedByName ?? "iemand anders" });
}

async function findReport(id: string): Promise<HuntReportDocument> {
  const report = mongoose.isValidObjectId(id) ? await HuntReport.findById(id) : null;
  if (!report) throw new HuntReportError(404, "Hunt niet gevonden.");
  return report;
}

export async function createHuntReport(input: NewHuntReport, user: UserType): Promise<HuntReportView> {
  const huntCode = normalizeHuntCode(input.huntCode);
  if (!huntCode) throw new HuntReportError(400, "Huntcode ontbreekt.");
  const extension = resolvePhotoExtension(input.photo.mimetype);
  if (!extension) throw new HuntReportError(400, "Foto moet een JPEG, PNG of WebP zijn.");

  // Check for duplicate with one findOne call
  const existing = await HuntReport.findOne({ huntCode });
  if (existing) {
    throw new HuntReportError(409, "Deze code is al geregistreerd.", { reason: "duplicate", reportedByName: existing.reportedByName });
  }

  const time = new Date(input.huntTime);
  time.setSeconds(0, 0);

  let photo: string | null = null;
  let marker: MarkerDocument | null = null;

  try {
    photo = await savePhoto(input.photo.buffer, extension);
    marker = input.location
      ? await Marker.create({ area: input.area, time, type: MarkerType.Hunt, location: { type: "Point", coordinates: input.location } })
      : null;

    const report = await HuntReport.create({
      area: input.area as (typeof HUNT_AREAS)[number],
      huntCode,
      huntTime: time,
      kind: input.kind,
      photo,
      reportedBy: user._id,
      reportedByName: user.name,
      location: input.location ? { type: "Point", coordinates: input.location } : undefined,
      markerId: marker?._id,
    });
    return toHuntReportView(report, new Date());
  } catch (error) {
    // Clean up side effects; a concurrent registration of the same code loses the unique-index race
    if (photo) await deletePhoto(photo);
    if (marker) await Marker.deleteOne({ _id: marker._id });
    if (isDuplicateKeyError(error)) throw await duplicateError(huntCode);
    throw error;
  }
}

export async function listHuntReports(now = new Date()): Promise<HuntReportView[]> {
  const reports = await HuntReport.find().sort({ huntTime: -1 });
  return reports.map((report) => toHuntReportView(report, now));
}

export async function setHuntReportSubmitted(id: string, submitted: boolean, user: UserType): Promise<HuntReportView> {
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
  return toHuntReportView(report, new Date());
}

export async function deleteHuntReport(id: string, user: UserType): Promise<void> {
  const report = await findReport(id);
  if (!user.admin && report.reportedBy.toString() !== user._id.toString()) {
    throw new HuntReportError(403, "Alleen de melder of een admin kan deze hunt verwijderen.");
  }
  if (report.submittedAt) throw new HuntReportError(409, "Deze hunt is al ingestuurd en kan niet meer verwijderd worden.");
  await HuntReport.deleteOne({ _id: report._id });
  if (report.markerId) await Marker.deleteOne({ _id: report.markerId });
  await deletePhoto(report.photo);
}

export async function huntReportPhotoPath(id: string): Promise<string> {
  const report = await findReport(id);
  return photoFilePath(report.photo);
}

/**
 * Copy the status and points of scraped jotihunt.nl hunts to the reports with the same normalised code.
 * Returns how many reports were updated.
 */
export async function linkScrapedHunts(hunts: { huntCode: string | null; status: string | null; points: number }[], now = new Date()): Promise<number> {
  let updated = 0;
  for (const hunt of hunts) {
    if (!hunt.huntCode) continue;
    const huntCode = normalizeHuntCode(hunt.huntCode);
    if (!huntCode) continue;
    const result = await HuntReport.updateOne(
      { huntCode },
      { $set: { site: { status: (hunt.status ?? "").trim(), points: Number.isFinite(hunt.points) ? hunt.points : 0, seenAt: now } } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}
