import { describe, expect, test } from "bun:test";
import { huntReportStatus, normalizeHuntCode, resolvePhotoExtension, submitDeadline, SUBMIT_WINDOW_MS } from "./hunt-report.helpers";

const huntTime = new Date("2026-10-17T12:00:00Z");

describe("normalizeHuntCode", () => {
  test("removes all whitespace and uppercases", () => {
    expect(normalizeHuntCode(" ab 12\tc\n")).toBe("AB12C");
  });
  test("keeps other characters", () => {
    expect(normalizeHuntCode("ab-12")).toBe("AB-12");
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
