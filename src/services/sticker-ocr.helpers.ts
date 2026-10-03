/** Bounding box of the sticker in the photo, as Gemini returns it: [ymin, xmin, ymax, xmax], integers 0..1000 */
export type StickerBox = [number, number, number, number];

export interface StickerReading {
  code: string | null;
  codeConfidence: number;
  time: string | null;
  timeConfidence: number;
  box: StickerBox | null;
}

const CODE = /^[A-Za-z0-9]{4,12}$/;
const TIME = /^(\d{1,2})\s*[:.;,]\s*(\d{2})$/;
const clamp01 = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** A valid box: 4 numbers in 0..1000 (rounded) with min < max; anything else is null. */
export function parseStickerBox(value: unknown): StickerBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)) return null;
  const [ymin, xmin, ymax, xmax] = value.map((n: number) => Math.round(n));
  return ymin < ymax && xmin < xmax ? [ymin, xmin, ymax, xmax] : null;
}

/** Parse Gemini's JSON answer (optionally inside ``` fences); invalid parts become null / 0. Throws on non-JSON. */
export function parseStickerReading(text: string): StickerReading {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) throw new Error("Expected a JSON object");
  const code = typeof raw.code === "string" && CODE.test(raw.code.trim()) ? raw.code.trim() : null;
  let time: string | null = null;
  const match = typeof raw.time === "string" ? raw.time.trim().match(TIME) : null;
  if (match && Number(match[1]) <= 23 && Number(match[2]) <= 59) time = `${match[1].padStart(2, "0")}:${match[2]}`;
  return {
    code,
    codeConfidence: code ? clamp01(raw.codeConfidence) : 0,
    time,
    timeConfidence: time ? clamp01(raw.timeConfidence) : 0,
    box: parseStickerBox(raw.box),
  };
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Most recent occurrence of HH:MM (server local time) relative to `reference`; > 5 min ahead means the previous day. */
export function resolveReadTime(hhmm: string, reference: Date): Date {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const time = new Date(reference);
  time.setHours(hours, minutes, 0, 0);
  if (time.getTime() - reference.getTime() > FUTURE_TOLERANCE_MS) time.setDate(time.getDate() - 1);
  return time;
}
