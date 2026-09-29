import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker } from "../models/marker.model";
import { GeminiError, type StickerReader } from "./gemini.client";
import { fieldSource, photoMimeType } from "./hunt-report.helpers";
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
  /** Queue a report for reading (no-op when it is already waiting) */
  enqueue(id: string): void;
  /** Queue every report left pending/reading (e.g. by a restart); returns how many */
  resumePending(): Promise<number>;
  /** Resolves when the queue is empty (for tests) */
  idle(): Promise<void>;
  /** Forget every waiting report (the database was switched); a reading in progress finishes on its own */
  reset(): void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** In-process queue that reads the hunt code and handwritten time from report photos, one photo at a time. */
export function createHuntOcr(deps: HuntOcrDeps): HuntOcr {
  const sleep = deps.sleep ?? defaultSleep;
  const queue: string[] = [];
  let draining: Promise<void> | null = null;

  /** onError must never break the queue */
  function notifyError(error: unknown, id: string) {
    try {
      deps.onError?.(error, id);
    } catch {
      // ignore
    }
  }

  async function fail(id: string, error: string, attempts?: number) {
    const set: Record<string, unknown> = { "ocr.status": "failed", "ocr.error": error };
    if (attempts !== undefined) set["ocr.attempts"] = attempts;
    await HuntReport.updateOne({ _id: id }, { $set: set });
  }

  /** Store the reading; only fields that were not entered by hand. Re-fetches so a concurrent manual edit wins. */
  async function apply(id: string, reading: StickerReading, attempts: number) {
    const report: HuntReportDocument | null = await HuntReport.findById(id);
    if (!report) return;
    if (fieldSource(report.huntCode, report.huntCodeSource) !== "manual") {
      report.huntCode = reading.code;
      report.huntCodeSource = reading.code ? "ocr" : undefined;
    }
    let movedTime: Date | null = null;
    if (fieldSource(report.huntTime, report.huntTimeSource) !== "manual") {
      movedTime = reading.time ? resolveReadTime(reading.time, report.get("createdAt") as Date) : null;
      report.huntTime = movedTime;
      report.huntTimeSource = reading.time ? "ocr" : undefined;
    }
    report.set("ocr", {
      status: "done",
      attempts,
      codeConfidence: reading.codeConfidence,
      timeConfidence: reading.timeConfidence,
      rawTime: reading.time,
      readAt: new Date(),
    });
    await report.save();
    if (movedTime && report.markerId) await Marker.updateOne({ _id: report.markerId }, { $set: { time: movedTime } });
  }

  async function read(id: string) {
    for (;;) {
      const report = await HuntReport.findById(id);
      if (!report) return;
      if ((report.ocr?.attempts ?? 0) >= MAX_ATTEMPTS) {
        await fail(id, report.ocr?.error || "Lezen mislukt na meerdere pogingen.");
        return;
      }
      if (!deps.reader) {
        await fail(id, NO_KEY_ERROR);
        return;
      }
      const attempts = (report.ocr?.attempts ?? 0) + 1;
      await HuntReport.updateOne({ _id: id }, { $set: { "ocr.status": "reading", "ocr.attempts": attempts }, $unset: { "ocr.error": "" } });

      let photo: Buffer;
      try {
        photo = await deps.loadPhoto(report.photo);
      } catch (error) {
        await fail(id, "Foto niet gevonden.");
        notifyError(error, id);
        return;
      }

      try {
        const reading = await deps.reader.readSticker(photo.toString("base64"), photoMimeType(report.photo));
        await apply(id, reading, attempts);
        return;
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        if (error.retryable && attempts < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
          continue;
        }
        await fail(id, error.message);
        notifyError(error, id);
        return;
      }
    }
  }

  async function drain() {
    try {
      while (queue.length > 0) {
        const id = queue.shift()!;
        try {
          await read(id);
        } catch (error) {
          notifyError(error, id);
          await fail(id, "Lezen mislukt.").catch((failError) => notifyError(failError, id));
        }
      }
    } finally {
      draining = null;
    }
  }

  function enqueue(id: string) {
    if (!queue.includes(id)) queue.push(id);
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
