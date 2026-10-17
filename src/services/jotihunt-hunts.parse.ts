/**
 * The logged-in jotihunt.nl /hunts page ("Overzicht hunts"), as pure functions over its HTML.
 *
 * Checked against the real site on 17 Oct 2026: one table with the headers Deelgebied, Huntcode, Status, Punten and
 * Hunttijd, rows as plain `<tr><td>…</td></tr>` in its tbody. The page shows no location and has no detail pages (the QR
 * flow never shows the location back); see hunt-location-estimate for how a hunt gets one.
 */

export interface ParsedLocation {
  lat: number;
  lng: number;
  /** Metres; null when unknown */
  accuracy: number | null;
}

export type HuntStatusClass = "pending" | "approved" | "rejected" | "unknown";

export interface ScrapedHunt {
  /** Upsert key, see siteKeyOf */
  siteKey: string;
  /** Lowercase ("alpha") */
  area: string;
  huntTime: Date | null;
  /** The time as the site shows it */
  huntTimeText: string;
  status: HuntStatusClass;
  statusText: string;
  points: number;
  /** The site's hunt code; null when empty (QR hunts) */
  huntCode: string | null;
  /** Always null from the page; filled later by the location estimate */
  location: ParsedLocation | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML text

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

/** Visible text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed */
const textOf = (html: string) =>
  decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** Inner HTML of every `<tag>…</tag>` in the fragment (no nesting of the same tag) */
const innerOf = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi"))].map((match) => match[1]);

// ---------------------------------------------------------------------------------------------------------------------
// Fields

type Field = "area" | "huntCode" | "status" | "points" | "huntTime";

/** The header text of each column (case-insensitive, whole header); all five must be present */
const HEADERS: Record<Field, RegExp> = {
  area: /^deelgebied$/i,
  huntCode: /^hunt\s*code$/i,
  status: /^status$/i,
  points: /^punten$/i,
  huntTime: /^hunt\s*tijd$/i,
};

/** Column index per field from the header texts, in any order and next to other columns; null when one is missing */
export function columnsFromHeaders(headers: string[]): Record<Field, number> | null {
  const columns: Partial<Record<Field, number>> = {};
  for (const [field, pattern] of Object.entries(HEADERS) as [Field, RegExp][]) {
    const index = headers.findIndex((header) => pattern.test(header.trim()));
    if (index === -1) return null;
    columns[field] = index;
  }
  return columns as Record<Field, number>;
}

const AREA_WORD = /\b(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|oscar)\b/i;

const PENDING = /wacht|bevestig|beoordeel|behandel|afwachting|ingediend|gescand|pending|open|nieuw/i;
const APPROVED = /goedgekeurd|akkoord|geaccepteerd|approved|toegekend|bevestigd|accepted/i;
const REJECTED = /afgekeurd|geweigerd|ongeldig|rejected|denied|niet\s+(goedgekeurd|geaccepteerd|akkoord|toegekend|bevestigd|geldig)|afgewezen/i;

/**
 * Status class of the site's status text: rejected and approved wording first (a text names its outcome), then waiting
 * wording; without a known text, points > 0 means approved.
 */
export function classifyStatus(text: string, points: number): HuntStatusClass {
  if (REJECTED.test(text)) return "rejected";
  // "Bevestigd" is approved, "Wacht op bevestiging" is pending
  if (APPROVED.test(text) && !/wacht|bevestiging|beoordeling/i.test(text)) return "approved";
  if (PENDING.test(text)) return "pending";
  return points > 0 ? "approved" : "unknown";
}

// ---------------------------------------------------------------------------------------------------------------------
// Time (the site writes Europe/Amsterdam local time)

const amsterdamParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** Amsterdam wall-clock fields of an instant */
function wallClock(date: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = Object.fromEntries(amsterdamParts.formatToParts(date).map((part) => [part.type, Number(part.value)]));
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}

/** The instant of an Amsterdam wall-clock time (month 1-12); null when the fields are no real time */
function amsterdam(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
  let instant = wanted;
  // Twice: the offset at the first guess may differ from the one at the answer (around a DST switch)
  for (let pass = 0; pass < 2; pass++) {
    const clock = wallClock(new Date(instant));
    instant += wanted - Date.UTC(clock.y, clock.mo - 1, clock.d, clock.h, clock.mi, clock.s);
  }
  return new Date(instant);
}

/**
 * The hunt time as jotihunt.nl shows it, in Amsterdam local time: "2026-10-17 21:03(:00)" (what the site writes),
 * "17-10-2026 21:03(:15)" (also with / or .), or only "21:03" (its most recent occurrence; more than 5 min ahead of
 * `now` means yesterday). Null when not recognised.
 */
export function parseSiteHuntTime(text: string | null | undefined, now = new Date()): Date | null {
  const value = (text ?? "").trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) return amsterdam(+match[1], +match[2], +match[3], +match[4], +match[5], +(match[6] ?? 0));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}),?\s+(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) return amsterdam(+match[3], +match[2], +match[1], +match[4], +match[5], +(match[6] ?? 0));
  match = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) {
    const today = wallClock(now);
    const time = amsterdam(today.y, today.mo, today.d, +match[1], +match[2], +(match[3] ?? 0));
    if (!time) return null;
    if (time.getTime() - now.getTime() > 5 * 60 * 1000) time.setTime(time.getTime() - 24 * 60 * 60 * 1000);
    return time;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys

/**
 * Key a scraped hunt is stored under: its hunt code, else area + time, else area + the raw time text (a time the
 * parser could not read).
 */
export function siteKeyOf(hunt: Pick<ScrapedHunt, "area" | "huntCode" | "huntTime" | "huntTimeText">): string {
  if (hunt.huntCode) return `code:${hunt.huntCode}`;
  const area = hunt.area.trim().toLowerCase();
  return hunt.huntTime ? `time:${area}:${hunt.huntTime.toISOString()}` : `raw:${area}:${hunt.huntTimeText.trim()}`;
}

/** Sets every hunt's siteKey; a key seen twice in one page (same fox, same time, no code) gets a "#2" suffix. */
export function assignSiteKeys<T extends Parameters<typeof siteKeyOf>[0] & { siteKey: string }>(hunts: T[]): T[] {
  const seen = new Map<string, number>();
  for (const hunt of hunts) {
    const key = siteKeyOf(hunt);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    hunt.siteKey = count === 1 ? key : `${key}#${count}`;
  }
  return hunts;
}

/**
 * After hunt times were re-dated (clock-only times keep their stored date): new keys for the hunts keyed by time, with
 * the same "#2" suffixes for duplicates. Code keys never change.
 */
export function rekeyTimeHunts<T extends Parameters<typeof siteKeyOf>[0] & { siteKey: string }>(hunts: T[]): T[] {
  const seen = new Map<string, number>();
  for (const hunt of hunts) {
    if (!hunt.siteKey.startsWith("time:") || !hunt.huntTime) continue;
    const key = `time:${hunt.area.trim().toLowerCase()}:${hunt.huntTime.toISOString()}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    hunt.siteKey = count === 1 ? key : `${key}#${count}`;
  }
  return hunts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Page

/**
 * The hunts of a /hunts page: the table whose headers are the five hunt columns, one hunt per tbody row. Never throws.
 * `found` tells whether that table was there; without it the result carries an "Unknown hunts layout" warning (the
 * caller logs it). Rows without a fox or with too few cells (a "no hunts" placeholder) are skipped; skipped rows with
 * content give a warning. `skipped` counts the rows with content that gave no hunt (a one-cell placeholder aside): the
 * page is then incomplete and nothing may be deleted for missing from it.
 */
export function parseHuntsPage(html: string, now = new Date()): { hunts: ScrapedHunt[]; warning: string | null; found: boolean; skipped: number } {
  const tables = innerOf(html, "table");
  const seenHeaders: string[][] = [];
  for (const table of tables) {
    const headers = innerOf(table, "th").map(textOf);
    seenHeaders.push(headers);
    const columns = columnsFromHeaders(headers);
    if (!columns) continue;

    const width = Math.max(...Object.values(columns)) + 1;
    const body = innerOf(table, "tbody")[0] ?? table;
    const hunts: ScrapedHunt[] = [];
    let unreadable = 0;
    let skipped = 0;
    for (const row of innerOf(body, "tr")) {
      const cells = innerOf(row, "td").map(textOf);
      if (cells.length === 0) continue;
      const areaText = cells[columns.area] ?? "";
      const area = AREA_WORD.exec(areaText)?.[1].toLowerCase() ?? areaText.toLowerCase();
      if (cells.length < width || !area) {
        if (cells.some(Boolean) && cells.length >= width) unreadable++;
        if (cells.some(Boolean) && cells.length > 1) skipped++;
        continue;
      }
      const points = Number.parseInt(cells[columns.points].replace(/[^\d-]/g, ""), 10);
      const statusText = cells[columns.status];
      const huntCode = cells[columns.huntCode].replace(/\s+/g, "");
      const huntTimeText = cells[columns.huntTime];
      const safePoints = Number.isFinite(points) ? points : 0;
      hunts.push({
        siteKey: "",
        area,
        huntTime: parseSiteHuntTime(huntTimeText, now),
        huntTimeText,
        status: classifyStatus(statusText, safePoints),
        statusText,
        points: safePoints,
        huntCode: huntCode || null,
        location: null,
      });
    }
    const warning = unreadable > 0 ? `${unreadable} hunts row(s) without a deelgebied were skipped` : null;
    return { hunts: assignSiteKeys(hunts), warning, found: true, skipped };
  }
  const described = seenHeaders.length > 0 ? seenHeaders.map((headers) => `[${headers.map((header) => JSON.stringify(header)).join(", ")}]`).join(" ") : "no tables";
  return { hunts: [], warning: `Unknown hunts layout (${described})`, found: false, skipped: 0 };
}
