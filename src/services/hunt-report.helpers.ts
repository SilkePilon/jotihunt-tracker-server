/** Fox teams a hunt can be registered for (lowercase, like Marker.area). */
export const HUNT_AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"] as const;

/** A hunt code must be entered on jotihunt.nl within 30 minutes of the hunt (spelregels §5). */
export const SUBMIT_WINDOW_MS = 30 * 60 * 1000;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type HuntReportStatus = "to_submit" | "overdue" | "submitted" | "judged";

export const FIELD_SOURCES = ["ocr", "manual"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];
export const OCR_STATUSES = ["pending", "reading", "done", "failed"] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];
/** An OCR-read value below this confidence has to be checked by HQ. */
export const REVIEW_CONFIDENCE = 0.7;

const PHOTO_EXTENSIONS: Record<string, ".jpg" | ".png" | ".webp"> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Hunt codes are case-sensitive ("GNcrZRZ"); only whitespace is removed. */
export function normalizeHuntCode(code: string): string {
  return code.replace(/\s+/g, "");
}

export function submitDeadline(huntTime: Date): Date {
  return new Date(huntTime.getTime() + SUBMIT_WINDOW_MS);
}

/**
 * Status of a report: judged (the scraped site has it) > submitted (HQ clicked "Ingestuurd") > within the
 * 30-minute window > overdue.
 */
export function huntReportStatus(report: { huntTime: Date; submittedAt?: Date | null; site?: { status: string } | null }, now: Date): HuntReportStatus {
  if (report.site) return "judged";
  if (report.submittedAt) return "submitted";
  return now.getTime() <= submitDeadline(report.huntTime).getTime() ? "to_submit" : "overdue";
}

/** Image type of a stored photo, from its file extension. */
export function photoMimeType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return Object.keys(PHOTO_EXTENSIONS).find((type) => PHOTO_EXTENSIONS[type] === extension) ?? "image/jpeg";
}

/** The hunt time used for status, deadline, sorting and the marker: the read/entered time, else the upload time. */
export function effectiveHuntTime(report: { huntTime?: Date | null; createdAt: Date }): Date {
  return report.huntTime ?? report.createdAt;
}

/** Where a field's value came from; values without a source were entered by hand before OCR existed. */
export function fieldSource(value: unknown, source: string | null | undefined): FieldSource | null {
  if (source === "ocr" || source === "manual") return source;
  return value === null || value === undefined ? null : "manual";
}

interface ReviewInput {
  huntCode?: string | null;
  huntTime?: Date | null;
  huntCodeSource?: string | null;
  huntTimeSource?: string | null;
  ocr?: { status: string; codeConfidence?: number | null; timeConfidence?: number | null } | null;
}

/**
 * HQ has to check a report when OCR failed, the code or time is missing, or an OCR-read value has a
 * confidence below REVIEW_CONFIDENCE. Manual values are trusted.
 */
export function needsReview(report: ReviewInput): boolean {
  if (report.ocr?.status === "pending" || report.ocr?.status === "reading") return false;
  const codeSource = fieldSource(report.huntCode, report.huntCodeSource);
  const timeSource = fieldSource(report.huntTime, report.huntTimeSource);
  if (report.ocr?.status === "failed" && !(codeSource === "manual" && timeSource === "manual")) return true;
  if (!report.huntCode || !report.huntTime) return true;
  if (codeSource === "ocr" && (report.ocr?.codeConfidence ?? 0) < REVIEW_CONFIDENCE) return true;
  if (timeSource === "ocr" && (report.ocr?.timeConfidence ?? 0) < REVIEW_CONFIDENCE) return true;
  return false;
}

/** File extension for an allowed photo type, or null when the type is not allowed. */
export function resolvePhotoExtension(mimetype: string): ".jpg" | ".png" | ".webp" | null {
  return PHOTO_EXTENSIONS[mimetype] ?? null;
}
