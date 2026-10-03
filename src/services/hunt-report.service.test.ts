import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import mongoose from "mongoose";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HuntReport } from "../models/hunt-report.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import { linkScrapedHunts } from "./hunt-report-sync.service";
import { findDuplicateOf, toHuntReportView } from "./hunt-report.view";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  listHuntReports,
  ORPHAN_PHOTO_AGE_MS,
  removeOrphanPhotos,
  requestHuntReportRead,
  restoreMissingHuntMarkers,
  setHuntReportFields,
  setHuntReportSubmitted,
  type NewHuntReport,
} from "./hunt-report.service";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "hunt-photos-"));

const huntTime = new Date("2026-10-17T12:03:00Z");

function input(overrides: Partial<NewHuntReport> = {}): NewHuntReport {
  return {
    area: "alpha",
    huntCode: " Gy3M 8XI ",
    huntTime,
    photo: { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: "image/jpeg" },
    ...overrides,
  };
}

async function makeUser(name: string, admin = false) {
  return User.create({ email: `${name}@test.nl`, password: "x", name, admin });
}

async function expectReportError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(status);
    return error as ServiceError;
  }
  throw new Error(`Expected ServiceError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  // Clean up uploads directory for a fresh start
  const uploadsDir = process.env.UPLOADS_DIR!;
  try {
    rmSync(uploadsDir, { recursive: true, force: true });
  } catch {
    // Ignore if directory doesn't exist
  }
});
afterAll(disconnectTestDb);

describe("createHuntReport", () => {
  test("a retried upload with the same uploadId returns the existing report (no second photo or marker)", async () => {
    const merida = await makeUser("merida");
    const uploadId = "6f1c1e7a-2b3c-4d5e-8f90-123456789abc";
    const first = await createHuntReport(input({ uploadId, location: [5.9, 52.2] }), merida);
    const again = await createHuntReport(input({ uploadId, location: [5.9, 52.2] }), merida);
    expect(again._id).toBe(first._id);
    expect(await HuntReport.countDocuments()).toBe(1);
    expect(await Marker.countDocuments()).toBe(1);
    expect(readdirSync(process.env.UPLOADS_DIR!).length).toBe(1);
  });

  test("the same uploadId from another user is a separate report; reports without uploadId never collide", async () => {
    const merida = await makeUser("merida");
    const elsa = await makeUser("elsa");
    const uploadId = "6f1c1e7a-2b3c-4d5e-8f90-123456789abc";
    const fromMerida = await createHuntReport(input({ uploadId }), merida);
    const fromElsa = await createHuntReport(input({ uploadId }), elsa);
    expect(fromElsa._id).not.toBe(fromMerida._id);
    await createHuntReport(input(), merida);
    await createHuntReport(input(), merida);
    expect(await HuntReport.countDocuments()).toBe(4);
  });

  test("stores a normalised code, the photo and the reporter", async () => {
    const user = await makeUser("merida");
    const view = await createHuntReport(input(), user);
    expect(view.huntCode).toBe("Gy3M8XI");
    expect(view.reportedByName).toBe("merida");
    expect(view.status).toBe("to_submit");
    expect(view.photoUrl).toBe(`/hunt-reports/${view._id}/photo`);
    expect(existsSync(await huntReportPhotoPath(view._id))).toBe(true);
  });

  test("creates a hunt marker at the phone position", async () => {
    const user = await makeUser("merida");
    await createHuntReport(input({ location: [5.9, 52.2] }), user);
    const markers = await Marker.find();
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe(MarkerType.Hunt);
    expect(markers[0].area).toBe("alpha");
    expect(markers[0].location!.coordinates).toEqual([5.9, 52.2]);
    expect(markers[0].time.toISOString()).toBe("2026-10-17T12:03:00.000Z");
  });

  test("no marker without a position", async () => {
    const user = await makeUser("merida");
    await createHuntReport(input(), user);
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("cleans up the photo when marker creation fails", async () => {
    const user = await makeUser("merida");
    const spy = spyOn(Marker, "create");
    spy.mockRejectedValueOnce(new Error("boom"));
    try {
      await createHuntReport(input({ location: [5.9, 52.2] }), user);
      throw new Error("Expected createHuntReport to reject");
    } catch (error) {
      if (error instanceof Error && error.message === "Expected createHuntReport to reject") throw error;
      // Expected to reject
    }
    expect(await HuntReport.countDocuments()).toBe(0);
    const uploadsDir = process.env.UPLOADS_DIR!;
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  test("cleans up the report, marker and photo when a step after the marker fails", async () => {
    const user = await makeUser("merida");
    const spy = spyOn(HuntReport, "find").mockImplementationOnce((() => {
      throw new Error("boom");
    }) as never);
    try {
      await expect(createHuntReport(input({ location: [5.9, 52.2] }), user)).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect(await HuntReport.countDocuments()).toBe(0);
    expect(await Marker.countDocuments()).toBe(0);
    expect(readdirSync(process.env.UPLOADS_DIR!)).toHaveLength(0);
  });

  test("a duplicate code is accepted and flagged with the first reporter", async () => {
    const merida = await makeUser("merida");
    const mulan = await makeUser("mulan");
    const first = await createHuntReport(input(), merida);
    const second = await createHuntReport(input({ huntCode: "Gy3M8XI" }), mulan);
    expect(first.duplicateOf).toBeNull();
    expect(second.duplicateOf).toEqual({ id: first._id, reportedByName: "merida" });
    expect(await HuntReport.countDocuments()).toBe(2);
    const views = await listHuntReports();
    expect(views.find((view) => view._id === first._id)!.duplicateOf).toBeNull();
    expect(views.find((view) => view._id === second._id)!.duplicateOf).toEqual({ id: first._id, reportedByName: "merida" });
  });

  test("codes differing only in case are different hunts", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input({ huntCode: "GNcrZRZ" }), merida);
    const other = await createHuntReport(input({ huntCode: "GNCRZRZ" }), merida);
    expect(other.huntCode).toBe("GNCRZRZ");
    expect(await HuntReport.countDocuments()).toBe(2);
  });

  test("rejects a disallowed photo type with 400", async () => {
    const user = await makeUser("merida");
    await expectReportError(createHuntReport(input({ photo: { buffer: Buffer.from("x"), mimetype: "image/gif" } }), user), 400);
  });

  test("code and time entered by hand: manual sources, nothing to read", async () => {
    const user = await makeUser("merida");
    const view = await createHuntReport(input(), user);
    expect(view).toMatchObject({ huntTimeKnown: true, huntCodeSource: "manual", huntTimeSource: "manual", ocrStatus: "done", needsReview: false, duplicateOf: null });
  });

  test("photo only: pending OCR, effective time is the upload time, marker at the upload time", async () => {
    const user = await makeUser("merida");
    const before = Date.now();
    const view = await createHuntReport(input({ huntCode: undefined, huntTime: undefined, location: [5.9, 52.2] }), user);
    expect(view).toMatchObject({ huntCode: null, huntTimeKnown: false, huntCodeSource: null, huntTimeSource: null, ocrStatus: "pending", needsReview: false });
    expect(view.huntTime).toBe(view.createdAt);
    expect(view.deadline).toBe(new Date(new Date(view.createdAt).getTime() + 30 * 60 * 1000).toISOString());
    const [marker] = await Marker.find();
    expect(marker.time.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(marker.time.getTime()).toBeLessThanOrEqual(Date.now());
    const stored = await HuntReport.findById(view._id);
    expect(stored!.ocr).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("an empty code counts as not entered", async () => {
    const user = await makeUser("merida");
    const view = await createHuntReport(input({ huntCode: "  " }), user);
    expect(view.huntCode).toBeNull();
    expect(view.ocrStatus).toBe("pending");
    expect(view.huntTimeSource).toBe("manual");
  });
});

describe("existing reports from before OCR", () => {
  test("are shown as read with manual values", async () => {
    const merida = await makeUser("merida");
    // Raw insert like the old schema: no ocr sub-document, no sources
    await HuntReport.collection.insertOne({
      area: "alpha",
      huntCode: "OLD1",
      huntTime,
      photo: "old.jpg",
      reportedBy: merida._id,
      reportedByName: "merida",
      createdAt: huntTime,
    });
    const [view] = await listHuntReports(new Date("2026-10-17T12:10:00Z"));
    expect(view).toMatchObject({
      huntCode: "OLD1",
      huntTime: huntTime.toISOString(),
      huntTimeKnown: true,
      huntCodeSource: "manual",
      huntTimeSource: "manual",
      ocrStatus: "done",
      codeConfidence: null,
      timeConfidence: null,
      needsReview: false,
      duplicateOf: null,
      status: "to_submit",
    });
  });
});

describe("setHuntReportFields", () => {
  test("an admin sets code and time by hand; the marker follows the time", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntCode: undefined, huntTime: undefined, location: [5.9, 52.2] }), merida);
    const view = await setHuntReportFields(report._id, { huntCode: " GNcr ZRZ", huntTime: new Date("2026-10-17T11:17:42Z") }, hq);
    expect(view).toMatchObject({ huntCode: "GNcrZRZ", huntTime: "2026-10-17T11:17:00.000Z", huntTimeKnown: true, huntCodeSource: "manual", huntTimeSource: "manual" });
    const [marker] = await Marker.find();
    expect(marker.time.toISOString()).toBe("2026-10-17T11:17:00.000Z");
  });

  test("only the given field changes", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntTime: undefined }), merida);
    const view = await setHuntReportFields(report._id, { huntTime: new Date("2026-10-17T11:17:00Z") }, hq);
    expect(view.huntCode).toBe("Gy3M8XI");
    expect(view.huntTimeSource).toBe("manual");
  });

  test("a manual value clears the review once both fields are manual, also after a failed read", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntCode: undefined, huntTime: undefined }), merida);
    await HuntReport.updateOne({ _id: report._id }, { $set: { ocr: { status: "failed", attempts: 1, error: "x" } } });
    const view = await setHuntReportFields(report._id, { huntCode: "ABCD", huntTime }, hq);
    expect(view.ocrStatus).toBe("failed");
    expect(view.needsReview).toBe(false);
  });

  test("changing the code clears the jotihunt.nl result, keeping the same code does not", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input(), merida);
    await HuntReport.updateOne({ _id: report._id }, { $set: { site: { status: "goed", points: 5, seenAt: new Date() } } });
    expect((await setHuntReportFields(report._id, { huntCode: "Gy3M8XI" }, hq)).site).not.toBeNull();
    expect((await setHuntReportFields(report._id, { huntCode: "NEWC" }, hq)).site).toBeNull();
  });

  test("a pending reading is done once code and time are both manual", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntCode: undefined, huntTime: undefined }), merida);
    expect((await setHuntReportFields(report._id, { huntCode: "ABCD" }, hq)).ocrStatus).toBe("pending");
    const view = await setHuntReportFields(report._id, { huntTime }, hq);
    expect(view.ocrStatus).toBe("done");
    expect((await HuntReport.findById(report._id))!.ocr!.status).toBe("done");
  });

  test("403 for non-admins, 400 for an empty code or nothing to change, 404 unknown", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input(), merida);
    await expectReportError(setHuntReportFields(report._id, { huntCode: "ABCD" }, merida), 403);
    await expectReportError(setHuntReportFields(report._id, { huntCode: "  " }, hq), 400);
    await expectReportError(setHuntReportFields(report._id, {}, hq), 400);
    await expectReportError(setHuntReportFields("0123456789abcdef01234567", { huntCode: "ABCD" }, hq), 404);
  });
});

describe("requestHuntReportRead", () => {
  test("clears the code and time, also values entered by hand, and reads again", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntTime: undefined }), merida);
    await HuntReport.updateOne(
      { _id: report._id },
      { $set: { huntTime, huntTimeSource: "ocr", ocr: { status: "done", attempts: 1, codeConfidence: 0.9, timeConfidence: 0.4, rawTime: "12:03", readAt: new Date() } } },
    );
    const view = await requestHuntReportRead(report._id, hq);
    expect(view).toMatchObject({ huntCode: null, huntCodeSource: null, huntTimeKnown: false, huntTimeSource: null, ocrStatus: "pending", timeConfidence: null });
    const stored = await HuntReport.findById(report._id);
    expect(stored!.huntTime).toBeNull();
    expect(stored!.ocr).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("moves the marker back to the upload time when the time is reset", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input({ huntTime: undefined, location: [5.9, 52.2] }), merida);
    await HuntReport.updateOne({ _id: report._id }, { $set: { huntTime, huntTimeSource: "ocr" } });
    await Marker.updateMany({}, { $set: { time: huntTime } });
    await requestHuntReportRead(report._id, hq);
    const expected = new Date((await HuntReport.findById(report._id))!.get("createdAt") as Date);
    expected.setSeconds(0, 0);
    const [marker] = await Marker.find();
    expect(marker.time).toEqual(expected);
  });

  test("also clears values from before OCR", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const { insertedId } = await HuntReport.collection.insertOne({ area: "alpha", huntCode: "OLD1", huntTime, photo: "old.jpg", reportedBy: merida._id, reportedByName: "merida", createdAt: huntTime });
    const view = await requestHuntReportRead(insertedId.toString(), hq);
    expect(view).toMatchObject({ huntCode: null, huntTimeKnown: false, ocrStatus: "pending" });
  });

  test("403 for non-admins", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    await expectReportError(requestHuntReportRead(report._id, merida), 403);
  });
});

describe("setHuntReportSubmitted", () => {
  test("sets and clears the submitter", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq", true);
    const report = await createHuntReport(input(), merida);
    const submitted = await setHuntReportSubmitted(report._id, true, hq);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedByName).toBe("hq");
    const reverted = await setHuntReportSubmitted(report._id, false, hq);
    expect(reverted.submittedAt).toBeNull();
    expect(reverted.submittedByName).toBeNull();
  });

  test("403 for a non-admin, also the reporter", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    await expectReportError(setHuntReportSubmitted(report._id, true, merida), 403);
  });

  test("404 for an unknown id", async () => {
    const hq = await makeUser("hq", true);
    await expectReportError(setHuntReportSubmitted("0123456789abcdef01234567", true, hq), 404);
  });
});

describe("deleteHuntReport", () => {
  test("an admin can delete while not submitted; photo and marker go too", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    const photo = await huntReportPhotoPath(report._id);
    await deleteHuntReport(report._id, admin);
    expect(await HuntReport.countDocuments()).toBe(0);
    expect(await Marker.countDocuments()).toBe(0);
    expect(existsSync(photo)).toBe(false);
  });

  test("an admin can delete someone else's report", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input(), merida);
    await deleteHuntReport(report._id, admin);
    expect(await HuntReport.countDocuments()).toBe(0);
  });

  test("403 for non-admins, also the reporter", async () => {
    const merida = await makeUser("merida");
    const mulan = await makeUser("mulan");
    const report = await createHuntReport(input(), merida);
    await expectReportError(deleteHuntReport(report._id, mulan), 403);
    await expectReportError(deleteHuntReport(report._id, merida), 403);
  });

  test("409 once submitted", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input(), merida);
    await setHuntReportSubmitted(report._id, true, admin);
    await expectReportError(deleteHuntReport(report._id, admin), 409);
  });
});

describe("linkScrapedHunts", () => {
  test("copies status and points to the report with the same normalised code", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input(), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    const updated = await linkScrapedHunts([{ huntCode: "Gy3M8XI ", status: "Goedgekeurd", points: 5 }, { huntCode: null, status: null, points: 0 }], now);
    expect(updated).toBe(1);
    const [view] = await listHuntReports(now);
    expect(view.status).toBe("judged");
    expect(view.site).toEqual({ status: "Goedgekeurd", points: 5, seenAt: now.toISOString() });
  });

  test("409 once linked to a scraped hunt on jotihunt.nl", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    await linkScrapedHunts([{ huntCode: "Gy3M8XI", status: "Goedgekeurd", points: 5 }], now);
    await expectReportError(deleteHuntReport(report._id, await makeUser("admin", true)), 409);
  });

  test("reports without a code are never linked; with duplicates only the first report is", async () => {
    const merida = await makeUser("merida");
    const unread = await createHuntReport(input({ huntCode: undefined }), merida);
    const first = await createHuntReport(input(), merida);
    const second = await createHuntReport(input(), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    expect(await linkScrapedHunts([{ huntCode: "Gy3M8XI", status: "Goedgekeurd", points: 5 }], now)).toBe(1);
    const views = await listHuntReports(now);
    expect(views.find((view) => view._id === first._id)!.site).not.toBeNull();
    expect(views.find((view) => view._id === second._id)!.site).toBeNull();
    expect(views.find((view) => view._id === unread._id)!.site).toBeNull();
  });

  test("one query for all codes; a code scraped twice ends with the last values; unknown codes are skipped", async () => {
    const merida = await makeUser("merida");
    const a = await createHuntReport(input({ huntCode: "AAA" }), merida);
    const b = await createHuntReport(input({ huntCode: "BBB" }), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    const updated = await linkScrapedHunts(
      [
        { huntCode: "AAA", status: "In behandeling", points: 0 },
        { huntCode: "ZZZ", status: "Goedgekeurd", points: 5 },
        { huntCode: "BBB", status: " Afgekeurd ", points: Number.NaN },
        { huntCode: "AAA", status: "Goedgekeurd", points: 5 },
      ],
      now,
    );
    expect(updated).toBe(3);
    const views = await listHuntReports(now);
    expect(views.find((view) => view._id === a._id)!.site).toEqual({ status: "Goedgekeurd", points: 5, seenAt: now.toISOString() });
    expect(views.find((view) => view._id === b._id)!.site).toEqual({ status: "Afgekeurd", points: 0, seenAt: now.toISOString() });
    expect(await linkScrapedHunts([], now)).toBe(0);
  });
});

describe("listHuntReports", () => {
  test("newest hunt time first with derived status and deadline", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input({ huntCode: "OLD1", huntTime: new Date("2026-10-17T10:00:00Z") }), merida);
    await createHuntReport(input({ huntCode: "NEW1", huntTime: new Date("2026-10-17T12:00:00Z") }), merida);
    const views = await listHuntReports(new Date("2026-10-17T12:10:00Z"));
    expect(views.map((view) => view.huntCode)).toEqual(["NEW1", "OLD1"]);
    expect(views.map((view) => view.status)).toEqual(["to_submit", "overdue"]);
    expect(views[0].deadline).toBe("2026-10-17T12:30:00.000Z");
  });

  test("sorts by the effective time: an unread report uses its upload time", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input({ huntCode: "OLD1", huntTime: new Date("2020-01-01T10:00:00Z") }), merida);
    await createHuntReport(input({ huntCode: undefined, huntTime: undefined }), merida);
    const views = await listHuntReports();
    expect(views.map((view) => view.huntCode)).toEqual([null, "OLD1"]);
  });
});

/** Let the service load the report, then run `meanwhile` (a concurrent request) before it continues. */
function afterLoad(meanwhile: () => Promise<unknown>) {
  const original = HuntReport.findById.bind(HuntReport);
  return spyOn(HuntReport, "findById").mockImplementationOnce(((id: string) =>
    original(id).then(async (report) => {
      await meanwhile();
      return report;
    })) as never);
}

describe("races with a concurrent request", () => {
  test("a report submitted after the delete loaded it is not deleted: 409", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    const spy = afterLoad(() => HuntReport.updateOne({ _id: report._id }, { $set: { submittedAt: new Date() } }));
    await expectReportError(deleteHuntReport(report._id, admin), 409);
    spy.mockRestore();
    expect(await HuntReport.countDocuments()).toBe(1);
    expect(await Marker.countDocuments()).toBe(1);
    expect(existsSync(await huntReportPhotoPath(report._id))).toBe(true);
  });

  test("a report linked to jotihunt.nl after the delete loaded it is not deleted: 409", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input(), merida);
    const spy = afterLoad(() => linkScrapedHunts([{ huntCode: "Gy3M8XI", status: "Goedgekeurd", points: 5 }]));
    await expectReportError(deleteHuntReport(report._id, admin), 409);
    spy.mockRestore();
    expect(await HuntReport.countDocuments()).toBe(1);
  });

  test("a report deleted by someone else meanwhile: 404", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input(), merida);
    const spy = afterLoad(() => HuntReport.deleteOne({ _id: report._id }));
    await expectReportError(deleteHuntReport(report._id, admin), 404);
    spy.mockRestore();
  });

  test("PATCH, submitted and read of a report deleted meanwhile answer 404, not 500", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const edits = [
      (id: string) => setHuntReportFields(id, { huntCode: "NEW1", huntTime: new Date("2026-10-17T15:00:00Z") }, admin),
      (id: string) => setHuntReportSubmitted(id, true, admin),
      (id: string) => requestHuntReportRead(id, admin),
    ];
    for (const edit of edits) {
      const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
      const spy = afterLoad(() => HuntReport.deleteOne({ _id: report._id }));
      await expectReportError(edit(report._id), 404);
      spy.mockRestore();
    }
  });

  test("concurrent time edits leave the marker at the report's final time", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    for (let round = 0; round < 5; round++) {
      const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
      await Promise.all([
        ...Array.from({ length: 8 }, (_, i) => setHuntReportFields(report._id, { huntTime: new Date(`2026-10-17T14:${10 + i}:00Z`) }, admin)),
        requestHuntReportRead(report._id, admin),
      ]);
      const stored = (await HuntReport.findById(report._id).lean())!;
      const marker = (await Marker.findById(stored.markerId).lean())!;
      const expected = new Date(stored.huntTime ?? stored.createdAt);
      expected.setSeconds(0, 0);
      expect(marker.time.toISOString()).toBe(expected.toISOString());
    }
  });

  test("a time edit finishing first never leaves its older time on the marker", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    const original = Marker.updateOne.bind(Marker);
    // Edit A saved 14:10; before A moves the marker, edit B saves and moves it to 14:20; then A's marker update lands
    const spy = spyOn(Marker, "updateOne").mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      await setHuntReportFields(report._id, { huntTime: new Date("2026-10-17T14:20:00Z") }, admin);
      return original(...args);
    }) as never);
    await setHuntReportFields(report._id, { huntTime: new Date("2026-10-17T14:10:00Z") }, admin);
    spy.mockRestore();
    const stored = (await HuntReport.findById(report._id).lean())!;
    expect(stored.huntTime!.toISOString()).toBe("2026-10-17T14:20:00.000Z");
    expect((await Marker.findById(stored.markerId).lean())!.time.toISOString()).toBe("2026-10-17T14:20:00.000Z");
  });

  test("a code change clears a scraped result for the old code stored after the report was loaded", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input({ huntCode: "OLD1" }), merida);
    const spy = afterLoad(() => linkScrapedHunts([{ huntCode: "OLD1", status: "Goedgekeurd", points: 5 }]));
    await setHuntReportFields(report._id, { huntCode: "NEW1" }, admin);
    spy.mockRestore();
    const [view] = await listHuntReports();
    expect(view).toMatchObject({ huntCode: "NEW1", site: null });
  });

  test("a scraped result is not stored on a report whose code was changed meanwhile", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input({ huntCode: "OLD1" }), merida);
    const original = HuntReport.bulkWrite.bind(HuntReport);
    const spy = spyOn(HuntReport, "bulkWrite").mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      await setHuntReportFields(report._id, { huntCode: "NEW1" }, admin);
      return original(...args);
    }) as never);
    expect(await linkScrapedHunts([{ huntCode: "OLD1", status: "Goedgekeurd", points: 5 }])).toBe(0);
    spy.mockRestore();
    const [view] = await listHuntReports();
    expect(view).toMatchObject({ huntCode: "NEW1", site: null });
  });
});

describe("crash safety of uploads", () => {
  test("the report exists before its marker is created", async () => {
    const merida = await makeUser("merida");
    let reportsWhenMarkerCreated = -1;
    const original = Marker.create.bind(Marker);
    const spy = spyOn(Marker, "create").mockImplementationOnce((async (...args: unknown[]) => {
      reportsWhenMarkerCreated = await HuntReport.countDocuments({ markerId: { $exists: true } });
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const view = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    spy.mockRestore();
    expect(reportsWhenMarkerCreated).toBe(1);
    const stored = (await HuntReport.findById(view._id).lean())!;
    expect(String((await Marker.findOne().lean())!._id)).toBe(String(stored.markerId));
  });

  test("restoreMissingHuntMarkers recreates a marker lost between report and marker, not for fresh or unlinked reports", async () => {
    const merida = await makeUser("merida");
    const lost = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    const fresh = await createHuntReport(input({ huntCode: "FRESH", location: [5.8, 52.1] }), merida);
    const unlinked = await createHuntReport(input({ huntCode: "GONE", location: [5.7, 52.0] }), merida);
    const kept = await createHuntReport(input({ huntCode: "KEPT", location: [5.6, 51.9] }), merida);
    const lostMarkerId = (await HuntReport.findById(lost._id).lean())!.markerId;
    await Marker.deleteMany({ _id: { $ne: (await HuntReport.findById(kept._id).lean())!.markerId } });
    await HuntReport.updateOne({ _id: unlinked._id }, { $unset: { markerId: 1 } });
    // Only the fresh report was stored just now
    await HuntReport.collection.updateMany({ _id: { $ne: new mongoose.Types.ObjectId(fresh._id) } }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await restoreMissingHuntMarkers()).toBe(1);
    const markers = await Marker.find().lean();
    expect(markers).toHaveLength(2);
    const restored = markers.find((marker) => String(marker._id) === String(lostMarkerId))!;
    expect(restored).toMatchObject({ area: "alpha", type: MarkerType.Hunt });
    expect(restored.time.toISOString()).toBe("2026-10-17T12:03:00.000Z");
    expect(restored.location!.coordinates).toEqual([5.9, 52.2]);
    expect(await restoreMissingHuntMarkers()).toBe(0);
  });

  /** A photo file in the uploads directory, `ageMs` old */
  function photoFile(name: string, ageMs: number, dir = process.env.UPLOADS_DIR!) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, "x");
    const time = new Date(Date.now() - ageMs);
    utimesSync(file, time, time);
    return file;
  }

  test("removeOrphanPhotos removes old photos without a report only", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    const kept = await huntReportPhotoPath(report._id);
    utimesSync(kept, new Date(0), new Date(0));
    const orphan = photoFile("orphan.jpg", ORPHAN_PHOTO_AGE_MS + 60_000);
    const fresh = photoFile("uploading.jpg", 1_000);
    const demo = photoFile("demo-photo.jpg", ORPHAN_PHOTO_AGE_MS + 60_000, path.join(process.env.UPLOADS_DIR!, "demo"));
    expect(await removeOrphanPhotos()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(demo)).toBe(true);
  });

  test("removeOrphanPhotos never runs on a database without reports, nor without a directory", async () => {
    expect(await removeOrphanPhotos()).toBe(0);
    const orphan = photoFile("orphan.jpg", ORPHAN_PHOTO_AGE_MS + 60_000);
    expect(await removeOrphanPhotos()).toBe(0);
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("listHuntReports from lean documents", () => {
  test("gives exactly the views built from full documents", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const first = await createHuntReport(input({ huntCode: "DUP1", location: [5.9, 52.2], uploadId: "u1" }), merida);
    await createHuntReport(input({ huntCode: "DUP1" }), merida);
    const unread = await createHuntReport(input({ huntCode: undefined, huntTime: undefined }), merida);
    await HuntReport.updateOne({ _id: unread._id }, { $set: { ocr: { status: "failed", attempts: 3, error: "Lezen mislukt.", codeConfidence: 0.4, timeConfidence: 0.2, stickerBox: [1, 2, 3, 4], rawTime: "11:00", readAt: new Date() } } });
    await setHuntReportSubmitted(first._id, true, admin);
    await linkScrapedHunts([{ huntCode: "DUP1", status: "Goedgekeurd", points: 5 }]);
    await HuntReport.collection.insertOne({ area: "bravo", huntCode: "OLD1", huntTime, photo: "old.jpg", reportedBy: merida._id, reportedByName: "merida", createdAt: huntTime });

    const now = new Date("2026-10-17T12:10:00Z");
    const documents = await HuntReport.find();
    const expected = await Promise.all(documents.map(async (report) => toHuntReportView(report, now, await findDuplicateOf(report))));
    expected.sort((a, b) => b.huntTime.localeCompare(a.huntTime));
    expect(await listHuntReports(now)).toEqual(expected);
  });
});
