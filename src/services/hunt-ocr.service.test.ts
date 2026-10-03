import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HuntReport } from "../models/hunt-report.model";
import { Marker } from "../models/marker.model";
import { User, type UserType } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { GeminiError, type StickerReader } from "./gemini.client";
import { createHuntOcr } from "./hunt-ocr.service";
import { createHuntReport, listHuntReports, type NewHuntReport } from "./hunt-report.service";
import type { StickerReading } from "./sticker-ocr.helpers";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "hunt-ocr-"));

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
const reading: StickerReading = { code: "GNcrZRZ", codeConfidence: 0.95, time: "11:17", timeConfidence: 0.9, box: null };

/** Reader that answers with the given results in turn (an Error is thrown). */
function fakeReader(...results: (StickerReading | Error)[]) {
  const calls: { base64: string; mimeType: string }[] = [];
  const reader: StickerReader = {
    async readSticker(base64, mimeType) {
      calls.push({ base64, mimeType });
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { reader, calls };
}

function setup(reader: StickerReader | null) {
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const ocr = createHuntOcr({
    reader,
    loadPhoto: async () => PHOTO,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onError: (error) => errors.push(error),
  });
  return { ocr, sleeps, errors };
}

let user: UserType;

async function upload(overrides: Partial<NewHuntReport> = {}) {
  return createHuntReport({ area: "alpha", photo: { buffer: PHOTO, mimetype: "image/jpeg" }, location: [5.9, 52.2], ...overrides }, user);
}

async function stored(id: string) {
  return (await HuntReport.findById(id))!;
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  user = await User.create({ email: "merida@test.nl", password: "x", name: "merida" });
});
afterAll(disconnectTestDb);

describe("createHuntOcr", () => {
  test("stores the read code and time with OCR sources and moves the marker", async () => {
    const { reader, calls } = fakeReader(reading);
    const { ocr, sleeps } = setup(reader);
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();

    expect(calls).toEqual([{ base64: PHOTO.toString("base64"), mimeType: "image/jpeg" }]);
    const doc = await stored(report._id);
    expect(doc.huntCode).toBe("GNcrZRZ");
    expect(doc.huntCodeSource).toBe("ocr");
    expect(doc.huntTimeSource).toBe("ocr");
    const createdAt = doc.get("createdAt") as Date;
    const expected = new Date(createdAt);
    expected.setHours(11, 17, 0, 0);
    if (expected.getTime() - createdAt.getTime() > 5 * 60 * 1000) expected.setDate(expected.getDate() - 1);
    expect(doc.huntTime).toEqual(expected);
    expect(doc.ocr).toMatchObject({ status: "done", attempts: 1, codeConfidence: 0.95, timeConfidence: 0.9, rawTime: "11:17" });
    expect(doc.ocr!.readAt).toBeInstanceOf(Date);
    const marker = await Marker.findById(doc.markerId);
    expect(marker!.time).toEqual(expected);
    expect(sleeps).toEqual([]);

    const [view] = await listHuntReports();
    expect(view).toMatchObject({ ocrStatus: "done", huntTimeKnown: true, needsReview: false });
  });

  test("never overwrites manual values", async () => {
    const { reader } = fakeReader(reading);
    const { ocr } = setup(reader);
    const report = await upload({ huntCode: "Gy3M8XI" });
    ocr.enqueue(report._id);
    await ocr.idle();
    const doc = await stored(report._id);
    expect(doc.huntCode).toBe("Gy3M8XI");
    expect(doc.huntCodeSource).toBe("manual");
    expect(doc.huntTimeSource).toBe("ocr");
  });

  test("an unreadable value stays empty and needs review", async () => {
    const { reader } = fakeReader({ code: null, codeConfidence: 0, time: "11:17", timeConfidence: 0.4, box: null });
    const { ocr } = setup(reader);
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();
    const doc = await stored(report._id);
    expect(doc.huntCode).toBeNull();
    expect(doc.huntCodeSource).toBeUndefined();
    expect(doc.ocr!.status).toBe("done");
    const [view] = await listHuntReports();
    expect(view.needsReview).toBe(true);
  });

  test("retries 5xx and network errors with backoff, then succeeds", async () => {
    const { reader, calls } = fakeReader(new GeminiError("Gemini-verzoek mislukt (HTTP 503)", true, 503), new GeminiError("Gemini niet bereikbaar", true), reading);
    const { ocr, sleeps } = setup(reader);
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 20_000]);
    const doc = await stored(report._id);
    expect(doc.ocr).toMatchObject({ status: "done", attempts: 3 });
    expect(doc.huntCode).toBe("GNcrZRZ");
  });

  test("fails after 3 attempts", async () => {
    const { reader, calls } = fakeReader(new GeminiError("Gemini-verzoek mislukt (HTTP 429)", true, 429));
    const { ocr, sleeps, errors } = setup(reader);
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 20_000]);
    const doc = await stored(report._id);
    expect(doc.ocr).toMatchObject({ status: "failed", attempts: 3, error: "Gemini-verzoek mislukt (HTTP 429)" });
    expect(errors).toHaveLength(1);
  });

  test("fails at once on 4xx or an invalid answer", async () => {
    for (const error of [new GeminiError("Gemini-verzoek mislukt (HTTP 400)", false, 400), new GeminiError("Gemini gaf geen geldig antwoord", false)]) {
      await HuntReport.deleteMany({});
      const { reader, calls } = fakeReader(error);
      const { ocr, sleeps } = setup(reader);
      const report = await upload();
      ocr.enqueue(report._id);
      await ocr.idle();
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect((await stored(report._id)).ocr).toMatchObject({ status: "failed", attempts: 1, error: error.message });
    }
  });

  test("an unexpected error fails the report without crashing the queue", async () => {
    const { reader } = fakeReader(new Error("boom"), reading);
    const { ocr, errors } = setup(reader);
    const first = await upload();
    const second = await upload();
    ocr.enqueue(first._id);
    ocr.enqueue(second._id);
    await ocr.idle();
    expect((await stored(first._id)).ocr).toMatchObject({ status: "failed", error: "Lezen mislukt." });
    expect((await stored(second._id)).ocr!.status).toBe("done");
    expect(errors).toHaveLength(1);
  });

  test("a throwing onError does not stall the queue", async () => {
    const { reader } = fakeReader(new Error("boom"), reading);
    const ocr = createHuntOcr({ reader, loadPhoto: async () => PHOTO, sleep: async () => undefined, onError: () => { throw new Error("logger down"); } });
    const first = await upload();
    const second = await upload();
    ocr.enqueue(first._id);
    ocr.enqueue(second._id);
    await ocr.idle();
    expect((await stored(first._id)).ocr!.status).toBe("failed");
    expect((await stored(second._id)).ocr!.status).toBe("done");
    const third = await upload();
    ocr.enqueue(third._id);
    await ocr.idle();
    expect((await stored(third._id)).ocr!.status).toBe("done");
  });

  test("a report that already used all attempts fails without calling Gemini", async () => {
    const { reader, calls } = fakeReader(reading);
    const { ocr } = setup(reader);
    const report = await upload();
    await HuntReport.updateOne({ _id: report._id }, { $set: { "ocr.status": "reading", "ocr.attempts": 3 } });
    expect(await ocr.resumePending()).toBe(1);
    await ocr.idle();
    expect(calls).toHaveLength(0);
    expect((await stored(report._id)).ocr).toMatchObject({ status: "failed", attempts: 3 });
  });

  test("a missing photo fails the report", async () => {
    const { reader, calls } = fakeReader(reading);
    const ocr = createHuntOcr({
      reader,
      loadPhoto: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      sleep: async () => undefined,
      onError: () => undefined,
    });
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();
    expect(calls).toHaveLength(0);
    expect((await stored(report._id)).ocr).toMatchObject({ status: "failed", error: "Foto niet gevonden." });
  });

  test("without an API key the report fails with a clear message", async () => {
    const { ocr } = setup(null);
    const report = await upload();
    ocr.enqueue(report._id);
    await ocr.idle();
    expect((await stored(report._id)).ocr).toMatchObject({ status: "failed", error: "Geen GEMINI_API_KEY ingesteld" });
  });

  test("a report deleted before its turn is skipped", async () => {
    const { reader, calls } = fakeReader(reading);
    const { ocr, errors } = setup(reader);
    const report = await upload();
    await HuntReport.deleteOne({ _id: report._id });
    ocr.enqueue(report._id);
    await ocr.idle();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("reads one photo at a time in order, and an id is queued only once", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const reader: StickerReader = {
      async readSticker() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return reading;
      },
    };
    const ocr = createHuntOcr({ reader, loadPhoto: async (name) => (order.push(name), PHOTO), sleep: async () => undefined });
    const reports = [await upload(), await upload(), await upload()];
    for (const report of reports) ocr.enqueue(report._id);
    ocr.enqueue(reports[2]._id);
    await ocr.idle();
    expect(maxActive).toBe(1);
    const photos = await Promise.all(reports.map(async (report) => (await stored(report._id)).photo));
    expect(order).toEqual(photos);
  });

  test("resumePending queues pending and reading reports after a restart", async () => {
    const { reader, calls } = fakeReader(reading);
    const { ocr } = setup(reader);
    const pending = await upload();
    const reading1 = await upload();
    await HuntReport.updateOne({ _id: reading1._id }, { $set: { "ocr.status": "reading", "ocr.attempts": 1 } });
    const manual = await upload({ huntCode: "ABCD", huntTime: new Date() });
    const failed = await upload();
    await HuntReport.updateOne({ _id: failed._id }, { $set: { "ocr.status": "failed" } });

    expect(await ocr.resumePending()).toBe(2);
    await ocr.idle();
    expect(calls).toHaveLength(2);
    expect((await stored(pending._id)).ocr!.status).toBe("done");
    expect((await stored(reading1._id)).ocr!.status).toBe("done");
    expect((await stored(manual._id)).ocr!.status).toBe("done");
    expect((await stored(failed._id)).ocr!.status).toBe("failed");
  });
});
