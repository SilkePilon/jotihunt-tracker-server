import { normalizeHuntCode } from "./hunt-report.helpers";
import type { WebHunt } from "../types/api";

/** The /hunts table as text: header cells and the cells of every body row. */
export interface RawHuntsTable {
  headers: string[];
  rows: string[][];
}

type Field = "area" | "huntCode" | "status" | "points" | "huntTime";

/** Header text per field, checked in this order; one column per field ("Huntcode" is the code, "Hunttijd" the time). */
const HEADER_PATTERNS: [Field, RegExp][] = [
  ["huntCode", /code/i],
  ["huntTime", /tijd|time|datum|date|moment/i],
  ["points", /punt|point|score/i],
  ["status", /status|beoordel|resultaat/i],
  ["area", /gebied|area|vos|team/i],
];

/** The layout jotihunt.nl used up to 2026: area, huntcode, status, points, time. */
const LEGACY_LAYOUT: Record<Field, number> = { area: 0, huntCode: 1, status: 2, points: 3, huntTime: 4 };

/** Column index per field from the header texts; null when no area or time column is recognised. */
export function columnsFromHeaders(headers: string[]): Partial<Record<Field, number>> | null {
  const columns: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const [field, pattern] of HEADER_PATTERNS) {
    const index = headers.findIndex((header, column) => !used.has(column) && pattern.test(header.trim()));
    if (index === -1) continue;
    columns[field] = index;
    used.add(index);
  }
  return columns.area !== undefined && columns.huntTime !== undefined ? columns : null;
}

/** Most recent occurrence of a clock time (server local time) relative to `now`; more than 5 min ahead means yesterday. */
function recentClock(hours: number, minutes: number, seconds: number, now: Date): Date {
  const time = new Date(now);
  time.setHours(hours, minutes, seconds, 0);
  if (time.getTime() - now.getTime() > 5 * 60 * 1000) time.setDate(time.getDate() - 1);
  return time;
}

function valid(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The hunt time as jotihunt.nl shows it, in server local time (like the old Mongoose cast of the raw text):
 * "2026-10-17 21:03(:00)", "17-10-2026 21:03", "17/10/2026 21:03", an ISO time with a zone, or only "21:03".
 * Null when not recognised.
 */
export function parseSiteHuntTime(text: string | null | undefined, now = new Date()): Date | null {
  const value = (text ?? "").trim();
  if (!value) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (match) {
    if (match[7]) return valid(new Date(value.replace(" ", "T")));
    const [, y, mo, d, h, mi, s] = match;
    return valid(new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)));
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}),?\s+(?:om\s+)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) {
    const [, d, mo, y, h, mi, s] = match;
    return valid(new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)));
  }
  match = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) {
    const [h, mi, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    return h < 24 && mi < 60 ? recentClock(h, mi, s, now) : null;
  }
  return null;
}

/**
 * Key a scraped hunt is stored under: its code when it has one, else area + time (since 16 Oct 2026 hunts are
 * confirmed with the fox's QR code and may have no code), else area + the raw time text.
 */
export function siteKeyOf(hunt: Pick<WebHunt, "area" | "huntCode" | "huntTime" | "time">): string {
  if (hunt.huntCode) return `code:${hunt.huntCode}`;
  const area = hunt.area.trim().toLowerCase();
  return hunt.time ? `time:${area}:${hunt.time.toISOString()}` : `raw:${area}:${hunt.huntTime.trim()}`;
}

export interface ParsedHunts {
  hunts: WebHunt[];
  /** Set when the table layout is not recognised (logged by the caller) */
  warning: string | null;
}

/**
 * Turn the /hunts table into hunts. Columns are found by their header text, falling back to the old fixed layout.
 * Rows without a code are kept. Placeholder rows (a single "no hunts yet" cell) and rows without an area are skipped.
 */
export function parseHuntsTable(table: RawHuntsTable, now = new Date()): ParsedHunts {
  let columns = columnsFromHeaders(table.headers);
  let warning: string | null = null;
  if (!columns) {
    columns = LEGACY_LAYOUT;
    const nonEmpty = table.headers.some((header) => header.trim());
    if (nonEmpty) warning = `Unknown hunts table layout (headers: ${table.headers.map((header) => JSON.stringify(header.trim())).join(", ")}); assuming area, code, status, points, time`;
  }
  // A separate date and time column ("Datum", "Tijd") are read together
  const timePattern = HEADER_PATTERNS.find(([field]) => field === "huntTime")![1];
  const assigned = new Set(Object.values(columns));
  const extraTimeColumns = table.headers.flatMap((header, index) => (columns !== LEGACY_LAYOUT && !assigned.has(index) && timePattern.test(header.trim()) ? [index] : []));
  const needed = Math.max(...Object.values(columns).filter((index): index is number => index !== undefined)) + 1;
  const cell = (row: string[], field: Field) => {
    const index = columns[field];
    const value = index === undefined ? "" : (row[index] ?? "").trim();
    if (field !== "huntTime" || extraTimeColumns.length === 0) return value;
    return [value, ...extraTimeColumns.map((extra) => (row[extra] ?? "").trim())].filter(Boolean).join(" ");
  };

  const hunts = table.rows.flatMap((row): WebHunt[] => {
    if (row.length < needed) return [];
    const area = cell(row, "area");
    if (!area) return [];
    const code = normalizeHuntCode(cell(row, "huntCode"));
    // "-" or similar placeholders are no code
    const huntCode = /[A-Za-z0-9]/.test(code) ? code : null;
    const points = Number.parseInt(cell(row, "points").replace(/[^\d-]/g, ""), 10);
    const huntTime = cell(row, "huntTime");
    return [{ area, huntCode, status: cell(row, "status"), points: Number.isFinite(points) ? points : 0, huntTime, time: parseSiteHuntTime(huntTime, now) }];
  });
  if (!warning && table.rows.length > 0 && hunts.length === 0 && table.rows.some((row) => row.length >= needed)) {
    warning = `Hunts table has ${table.rows.length} row(s) but none could be read (headers: ${table.headers.map((header) => JSON.stringify(header.trim())).join(", ")})`;
  }
  return { hunts, warning };
}
