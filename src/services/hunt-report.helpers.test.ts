import { describe, expect, test } from "bun:test";
import { effectiveHuntTime, fieldSource, huntReportStatus, needsReview, normalizeHuntCode, photoMimeType, resolvePhotoExtension, submitDeadline, SUBMIT_WINDOW_MS } from "./hunt-report.helpers";

const huntTime = new Date("2026-10-17T12:00:00Z");

describe("normalizeHuntCode", () => {
  test("removes all whitespace and keeps the case (codes are case-sensitive)", () => {
    expect(normalizeHuntCode(" GN cr\tZRZ\n")).toBe("GNcrZRZ");
  });
  test("keeps other characters", () => {
    expect(normalizeHuntCode("ab-12")).toBe("ab-12");
  });
});

describe("submitDeadline", () => {
  test("is 30 minutes after the hunt time", () => {
    expect(submitDeadline(huntTime).getTime() - huntTime.getTime()).toBe(SUBMIT_WINDOW_MS);
  });
});

describe("huntReportStatus", () => {
  test("to_submit up to and including the deadline", () => {
    expect(huntReportStatus({ huntTime }, new Date("2026-10-17T12:30:00Z"))).toBe("to_submit");
  });
  test("overdue after the deadline", () => {
    expect(huntReportStatus({ huntTime }, new Date("2026-10-17T12:30:01Z"))).toBe("overdue");
  });
  test("submitted wins over the deadline", () => {
    expect(huntReportStatus({ huntTime, submittedAt: new Date("2026-10-17T12:40:00Z") }, new Date("2026-10-17T13:00:00Z"))).toBe("submitted");
  });
  test("judged wins over submitted", () => {
    expect(huntReportStatus({ huntTime, submittedAt: new Date(), site: { status: "Goedgekeurd" } }, new Date())).toBe("judged");
  });
  test("null fields count as missing", () => {
    expect(huntReportStatus({ huntTime, submittedAt: null, site: null }, huntTime)).toBe("to_submit");
  });
});

describe("resolvePhotoExtension", () => {
  test("maps allowed image types", () => {
    expect(resolvePhotoExtension("image/jpeg")).toBe(".jpg");
    expect(resolvePhotoExtension("image/png")).toBe(".png");
    expect(resolvePhotoExtension("image/webp")).toBe(".webp");
  });
  test("rejects everything else", () => {
    expect(resolvePhotoExtension("image/gif")).toBeNull();
    expect(resolvePhotoExtension("application/pdf")).toBeNull();
  });
});

describe("photoMimeType", () => {
  test("maps stored extensions back to the image type", () => {
    expect(photoMimeType("a.jpg")).toBe("image/jpeg");
    expect(photoMimeType("a.png")).toBe("image/png");
    expect(photoMimeType("a.webp")).toBe("image/webp");
    expect(photoMimeType("a.bin")).toBe("image/jpeg");
  });
});

describe("effectiveHuntTime", () => {
  const createdAt = new Date("2026-10-17T12:10:00Z");
  test("the read or entered time when known", () => {
    expect(effectiveHuntTime({ huntTime, createdAt })).toEqual(huntTime);
  });
  test("the upload time while unknown", () => {
    expect(effectiveHuntTime({ huntTime: null, createdAt })).toEqual(createdAt);
    expect(effectiveHuntTime({ createdAt })).toEqual(createdAt);
  });
});

describe("fieldSource", () => {
  test("an explicit source wins", () => {
    expect(fieldSource("ABCD", "ocr")).toBe("ocr");
    expect(fieldSource("ABCD", "manual")).toBe("manual");
  });
  test("a value without a source was entered by hand before OCR existed", () => {
    expect(fieldSource("ABCD", undefined)).toBe("manual");
    expect(fieldSource(huntTime, null)).toBe("manual");
  });
  test("no value, no source", () => {
    expect(fieldSource(null, undefined)).toBeNull();
    expect(fieldSource(undefined, null)).toBeNull();
  });
});

describe("needsReview", () => {
  const read = { huntCode: "ABCD", huntTime, huntCodeSource: "ocr", huntTimeSource: "ocr", ocr: { status: "done", codeConfidence: 0.9, timeConfidence: 0.8 } };
  test("false for confident OCR values", () => {
    expect(needsReview(read)).toBe(false);
  });
  test("true for a low confidence on an OCR-sourced field", () => {
    expect(needsReview({ ...read, ocr: { ...read.ocr, codeConfidence: 0.69 } })).toBe(true);
    expect(needsReview({ ...read, ocr: { ...read.ocr, timeConfidence: 0.5 } })).toBe(true);
    expect(needsReview({ ...read, ocr: { status: "done" } })).toBe(true);
  });
  test("a low confidence does not matter once the field is manual", () => {
    expect(needsReview({ ...read, huntCodeSource: "manual", ocr: { ...read.ocr, codeConfidence: 0.2 } })).toBe(false);
  });
  test("true when the code or the time is missing (also while reading)", () => {
    expect(needsReview({ ...read, huntCode: null, huntCodeSource: null })).toBe(true);
    expect(needsReview({ ...read, huntTime: null, huntTimeSource: null })).toBe(true);
    expect(needsReview({ huntCode: null, huntTime: null, ocr: { status: "pending" } })).toBe(true);
  });
  test("true when OCR failed, false once both fields are manual", () => {
    expect(needsReview({ huntCode: "ABCD", huntCodeSource: "manual", huntTime: null, ocr: { status: "failed" } })).toBe(true);
    expect(needsReview({ huntCode: "ABCD", huntCodeSource: "manual", huntTime, huntTimeSource: "manual", ocr: { status: "failed" } })).toBe(false);
  });
  test("reports from before OCR (no ocr, no sources) are fine", () => {
    expect(needsReview({ huntCode: "ABCD", huntTime })).toBe(false);
  });
});
