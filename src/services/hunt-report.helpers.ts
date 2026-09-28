/** Fox teams a hunt can be registered for (lowercase, like Marker.area). */
export const HUNT_AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"] as const;
export const HUNT_KINDS = ["hunt", "tegenhunt"] as const;
export type HuntKind = (typeof HUNT_KINDS)[number];

/** A hunt code must be entered on jotihunt.nl within 30 minutes of the hunt (spelregels §5). */
export const SUBMIT_WINDOW_MS = 30 * 60 * 1000;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type HuntReportStatus = "to_submit" | "overdue" | "submitted" | "judged";

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

/** File extension for an allowed photo type, or null when the type is not allowed. */
export function resolvePhotoExtension(mimetype: string): ".jpg" | ".png" | ".webp" | null {
  return PHOTO_EXTENSIONS[mimetype] ?? null;
}
