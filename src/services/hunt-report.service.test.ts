import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HuntReport } from "../models/hunt-report.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  HuntReportError,
  linkScrapedHunts,
  listHuntReports,
  setHuntReportSubmitted,
  type NewHuntReport,
} from "./hunt-report.service";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "hunt-photos-"));

const huntTime = new Date("2026-10-17T12:03:00Z");

function input(overrides: Partial<NewHuntReport> = {}): NewHuntReport {
  return {
    area: "alpha",
    huntCode: " ab12 cd ",
    huntTime,
    kind: "hunt",
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
    expect(error).toBeInstanceOf(HuntReportError);
    expect((error as HuntReportError).status).toBe(status);
    return error as HuntReportError;
  }
  throw new Error(`Expected HuntReportError ${status}`);
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
  test("stores a normalised code, the photo and the reporter", async () => {
    const user = await makeUser("merida");
    const view = await createHuntReport(input(), user);
    expect(view.huntCode).toBe("AB12CD");
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

  test("rejects a duplicate code with 409 and the first reporter's name", async () => {
    const merida = await makeUser("merida");
    const mulan = await makeUser("mulan");
    await createHuntReport(input(), merida);
    const error = await expectReportError(createHuntReport(input({ huntCode: "AB12CD" }), mulan), 409);
    expect(error.details).toEqual({ reason: "duplicate", reportedByName: "merida" });
    expect(await HuntReport.countDocuments()).toBe(1);
  });

  test("rejects an empty code and a disallowed photo type with 400", async () => {
    const user = await makeUser("merida");
    await expectReportError(createHuntReport(input({ huntCode: "  " }), user), 400);
    await expectReportError(createHuntReport(input({ photo: { buffer: Buffer.from("x"), mimetype: "image/gif" } }), user), 400);
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
    const updated = await linkScrapedHunts([{ huntCode: "ab12cd ", status: "Goedgekeurd", points: 5 }, { huntCode: null, status: null, points: 0 }], now);
    expect(updated).toBe(1);
    const [view] = await listHuntReports(now);
    expect(view.status).toBe("judged");
    expect(view.site).toEqual({ status: "Goedgekeurd", points: 5, seenAt: now.toISOString() });
  });

  test("409 once linked to a scraped hunt on jotihunt.nl", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    await linkScrapedHunts([{ huntCode: "ab12cd", status: "Goedgekeurd", points: 5 }], now);
    await expectReportError(deleteHuntReport(report._id, await makeUser("admin", true)), 409);
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
});
