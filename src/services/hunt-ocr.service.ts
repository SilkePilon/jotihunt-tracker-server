import mongoose from "mongoose";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { GeminiError, type StickerReader } from "./gemini.client";
import { fieldSource, photoMimeType } from "./hunt-report.helpers";
import { syncHuntMarkerTime } from "./hunt-report.service";
import { resolveReadTime, type StickerReading } from "./sticker-ocr.helpers";

export const MAX_ATTEMPTS = 3;
/** Wait before the 2nd and 3rd attempt */
export const RETRY_DELAYS_MS = [5_000, 20_000];
export const NO_KEY_ERROR = "Geen GEMINI_API_KEY ingesteld";

export interface HuntOcrDeps {
  /** null when GEMINI_API_KEY is not set: every reading fails with NO_KEY_ERROR */
  reader: StickerReader | null;
  /** Photo bytes by stored file name */
  loadPhoto: (name: string) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  /** Called when a reading finally fails or something unexpected goes wrong; never throws into the process */
  onError?: (error: unknown, reportId: string) => void;
}

export interface HuntOcr {
  /** Queue a report for reading (no-op when it is already waiting or being read) */
  enqueue(id: string): void;
  /** Queue every report left pending/reading (e.g. by a restart); returns how many */
  resumePending(): Promise<number>;
  /** Resolves when the queue is empty (for tests) */
  idle(): Promise<void>;
  /** Forget every waiting report (the database was switched); a reading in progress stops before its next attempt */
  reset(): void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * In-process queue that reads the hunt code and handwritten time from report photos, one photo at a time. Every
 * attempt is tracked for the demo switch (a switch waits for it; while a switch runs, the reading is skipped and
 * picked up again by resumePending); the waits between attempts are not.
 */
export function createHuntOcr(deps: HuntOcrDeps): HuntOcr {
  const sleep = deps.sleep ?? defaultSleep;
  const queue: string[] = [];
  /** The report being read now; queueing it again would read the same photo twice */
  let reading: string | null = null;
  let draining: Promise<void> | null = null;

  /** onError must never break the queue */
  function notifyError(error: unknown, id: string) {
    try {
      deps.onError?.(error, id);
    } catch {
      // ignore
    }
  }

  /** Report ids belong to the database of the generation their reading started in */
  async function fail(id: string, generation: number, error: string, attempts?: number) {
    if (currentGeneration() !== generation) return;
    const set: Record<string, unknown> = { "ocr.status": "failed", "ocr.error": error };
    if (attempts !== undefined) set["ocr.attempts"] = attempts;
    await HuntReport.updateOne({ _id: id }, { $set: set });
  }

  /** Store the reading; only fields that were not entered by hand. Re-fetches so a concurrent manual edit wins. */
  async function apply(id: string, generation: number, reading: StickerReading, attempts: number) {
    const report: HuntReportDocument | null = await HuntReport.findById(id);
    if (!report) return;
    if (fieldSource(report.huntCode, report.huntCodeSource) !== "manual") {
      report.huntCode = reading.code;
      report.huntCodeSource = reading.code ? "ocr" : undefined;
    }
    let timeChanged = false;
    if (fieldSource(report.huntTime, report.huntTimeSource) !== "manual") {
      timeChanged = true;
      report.huntTime = reading.time ? resolveReadTime(reading.time, report.get("createdAt") as Date) : null;
      report.huntTimeSource = reading.time ? "ocr" : undefined;
    }
    report.set("ocr", {
      status: "done",
      attempts,
      codeConfidence: reading.codeConfidence,
      timeConfidence: reading.timeConfidence,
      rawTime: reading.time,
      readAt: new Date(),
      // Describes the photo, not the fields: stored even when code and time were entered by hand
      stickerBox: reading.box ?? undefined,
    });
    if (currentGeneration() !== generation) return;
    try {
      await report.save();
    } catch (error) {
      // Deleted while it was being read
      if (error instanceof mongoose.Error.DocumentNotFoundError) return;
      throw error;
    }
    if (timeChanged) await syncHuntMarkerTime(report._id);
  }

  /** One attempt; resolves with the wait before the next attempt, or null when the reading is finished. */
  async function attempt(id: string, generation: number): Promise<number | null> {
    const report = await HuntReport.findById(id);
    if (!report) return null;
    if ((report.ocr?.attempts ?? 0) >= MAX_ATTEMPTS) {
      await fail(id, generation, report.ocr?.error || "Lezen mislukt na meerdere pogingen.");
      return null;
    }
    if (!deps.reader) {
      await fail(id, generation, NO_KEY_ERROR);
      return null;
    }
    const attempts = (report.ocr?.attempts ?? 0) + 1;
    await HuntReport.updateOne({ _id: id }, { $set: { "ocr.status": "reading", "ocr.attempts": attempts }, $unset: { "ocr.error": "" } });

    let photo: Buffer;
    try {
      photo = await deps.loadPhoto(report.photo);
    } catch (error) {
      await fail(id, generation, "Foto niet gevonden.");
      notifyError(error, id);
      return null;
    }

    try {
      const reading = await deps.reader.readSticker(photo.toString("base64"), photoMimeType(report.photo));
      await apply(id, generation, reading, attempts);
      return null;
    } catch (error) {
      if (!(error instanceof GeminiError)) throw error;
      if (error.retryable && attempts < MAX_ATTEMPTS) return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      await fail(id, generation, error.message);
      notifyError(error, id);
      return null;
    }
  }

  async function read(id: string) {
    const generation = currentGeneration();
    for (;;) {
      // Skipped (undefined) while a demo switch runs or once the database was switched
      const retryAfter = await runTracked(
        async () => {
          try {
            return await attempt(id, generation);
          } catch (error) {
            notifyError(error, id);
            await fail(id, generation, "Lezen mislukt.").catch((failError) => notifyError(failError, id));
            return null;
          }
        },
        { generation },
      );
      if (retryAfter === undefined || retryAfter === null) return;
      await sleep(retryAfter);
    }
  }

  async function drain() {
    try {
      while (queue.length > 0) {
        const id = queue.shift()!;
        reading = id;
        try {
          await read(id);
        } catch (error) {
          notifyError(error, id);
        } finally {
          reading = null;
        }
      }
    } finally {
      draining = null;
    }
  }

  function enqueue(id: string) {
    if (id !== reading && !queue.includes(id)) queue.push(id);
    // No await between the loop's empty check and `draining = null`, so a new id is never left behind
    draining ??= drain();
  }

  return {
    enqueue,
    async resumePending() {
      const reports = await HuntReport.find({ "ocr.status": { $in: ["pending", "reading"] } })
        .select("_id")
        .sort({ createdAt: 1 });
      for (const report of reports) enqueue(report._id.toString());
      return reports.length;
    },
    async idle() {
      while (draining) await draining;
    },
    reset() {
      queue.length = 0;
    },
  };
}
