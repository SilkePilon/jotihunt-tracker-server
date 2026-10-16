/**
 * Everything we read from the logged-in jotihunt.nl hunts pages, as pure functions over HTML text.
 *
 * Since the QR rule (16 Oct 2026) the site registers each hunt itself: fox, QR code, registration time, location +
 * accuracy, status ("Wacht op bevestiging") and points. The real page layout was unknown when this was written, so it is
 * an educated guess that reads defensively: columns by header text, else fields by what a cell looks like, location
 * from any cell, link or data attribute. An unknown layout gives a warning, never an exception.
 *
 * Adapting to the real page: save its HTML as `__fixtures__/hunts-page-real.html`, add a test next to the others and
 * adjust the patterns below until it parses.
 */

/** One hunt row (table row or card) as found on the page */
export interface RawHuntRow {
  /** Cell texts (table) or the texts of the card's elements, in page order */
  cells: string[];
  /** Every href (and data-href / data-url) inside the row */
  links: string[];
  /** The row element's attributes plus the data-* / datetime attributes of its descendants (first one wins) */
  attrs: Record<string, string>;
  /** The row's own HTML, for logging */
  html: string;
}

export interface RawHuntsPage {
  /** Table header texts; empty for card layouts */
  headers: string[];
  rows: RawHuntRow[];
}

export interface ParsedLocation {
  lat: number;
  lng: number;
  /** Metres; null when the site shows none */
  accuracy: number | null;
}

export type HuntStatusClass = "pending" | "approved" | "rejected" | "unknown";

export interface ScrapedHunt {
  /** Upsert key, see siteKeyOf */
  siteKey: string;
  /** Lowercase ("alpha") when it is a known fox team */
  area: string;
  huntTime: Date | null;
  /** The time as the site shows it */
  huntTimeText: string;
  status: HuntStatusClass;
  statusText: string;
  points: number;
  qrCode: string | null;
  /** The old hunt code (before the QR rule); null on QR hunts */
  huntCode: string | null;
  location: ParsedLocation | null;
  /** Link to the hunt's own page, as written in the page (may be relative) */
  detailUrl: string | null;
  /** QR code read from the hunt's own page: stored, but never part of the siteKey (that page is not always read) */
  detailQrCode?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// A small forgiving HTML tree (no DOM in Bun; the scraper passes page.content())

interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlElement | string)[];
  parent: HtmlElement | null;
  start: number;
  end: number;
  /** Raw content of script elements */
  script?: string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", plusmn: "±", deg: "°", euro: "€", hellip: "…", ndash: "–", mdash: "—" };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "template", "noscript"]);
const INLINE = new Set(["a", "abbr", "b", "bdi", "code", "em", "i", "kbd", "label", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u", "var"]);
/** Opening one of these closes an open element of the listed tags, unless one of the boundary tags comes first */
const IMPLICIT_CLOSE: Record<string, { closes: string[]; boundary: string[] }> = {
  td: { closes: ["td", "th"], boundary: ["tr", "table"] },
  th: { closes: ["td", "th"], boundary: ["tr", "table"] },
  tr: { closes: ["tr", "td", "th"], boundary: ["table", "thead", "tbody", "tfoot"] },
  thead: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], boundary: ["table"] },
  tbody: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], boundary: ["table"] },
  tfoot: { closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], boundary: ["table"] },
  li: { closes: ["li"], boundary: ["ul", "ol"] },
  dt: { closes: ["dt", "dd"], boundary: ["dl"] },
  dd: { closes: ["dt", "dd"], boundary: ["dl"] },
  option: { closes: ["option"], boundary: ["select"] },
};

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attrs: {}, children: [], parent: null, start: 0, end: html.length };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  const popTo = (index: number, end: number) => {
    while (stack.length > index) stack.pop()!.end = end;
  };
  const text = (value: string) => {
    if (value) top().children.push(decodeEntities(value));
  };
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
    text(html.slice(last, match.index));
    last = TOKEN.lastIndex;
    const [token, closing, opening, attrText] = match;
    if (closing) {
      const tag = closing.toLowerCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag !== tag) continue;
        popTo(index, TOKEN.lastIndex);
        break;
      }
      continue;
    }
    if (!opening) continue; // comment or doctype
    const tag = opening.toLowerCase();
    const rule = IMPLICIT_CLOSE[tag];
    if (rule) {
      // The outermost closable element below the boundary (a new <tr> closes the open <td> and its <tr>)
      let closeFrom = -1;
      for (let index = stack.length - 1; index > 0; index--) {
        if (rule.boundary.includes(stack[index].tag)) break;
        if (rule.closes.includes(stack[index].tag)) closeFrom = index;
      }
      if (closeFrom > 0) popTo(closeFrom, match.index);
    }
    const attrs: Record<string, string> = {};
    ATTRIBUTE.lastIndex = 0;
    for (let attr = ATTRIBUTE.exec(attrText ?? ""); attr; attr = ATTRIBUTE.exec(attrText ?? "")) {
      const name = attr[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const element: HtmlElement = { tag, attrs, children: [], parent: top(), start: match.index, end: TOKEN.lastIndex };
    top().children.push(element);
    if (VOID.has(tag) || token.endsWith("/>")) continue;
    if (RAW_TEXT.has(tag)) {
      // Raw content up to the closing tag, not parsed as HTML
      const close = new RegExp(`</${tag}\\s*>`, "ig");
      close.lastIndex = TOKEN.lastIndex;
      const found = close.exec(html);
      const contentEnd = found ? found.index : html.length;
      element.script = html.slice(TOKEN.lastIndex, contentEnd);
      element.end = found ? close.lastIndex : html.length;
      TOKEN.lastIndex = element.end;
      last = element.end;
      continue;
    }
    stack.push(element);
  }
  text(html.slice(last));
  popTo(1, html.length);
  return root;
}

function* descendants(element: HtmlElement): Generator<HtmlElement> {
  for (const child of element.children) {
    if (typeof child === "string") continue;
    yield child;
    yield* descendants(child);
  }
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** Visible text; elements that are not inline are separated by a space */
function textOf(element: HtmlElement): string {
  const parts: string[] = [];
  const walk = (node: HtmlElement) => {
    if (RAW_TEXT.has(node.tag)) return;
    if (node.tag === "br") parts.push(" ");
    for (const child of node.children) {
      if (typeof child === "string") parts.push(child);
      else if (INLINE.has(child.tag)) walk(child);
      else {
        parts.push(" ");
        walk(child);
        parts.push(" ");
      }
    }
  };
  walk(element);
  return clean(parts.join(""));
}

/** The texts of a card: every element's own (direct) text, in page order */
function ownTexts(element: HtmlElement): string[] {
  const texts: string[] = [];
  const walk = (node: HtmlElement) => {
    if (RAW_TEXT.has(node.tag)) return;
    const own = clean(node.children.filter((child): child is string => typeof child === "string").join(" "));
    if (own) texts.push(own);
    for (const child of node.children) if (typeof child !== "string") walk(child);
  };
  walk(element);
  return texts;
}

const LINK_ATTRIBUTES = ["href", "data-href", "data-url", "data-link"];

function rowOf(element: HtmlElement, cells: string[], html: string): RawHuntRow {
  const links: string[] = [];
  const attrs: Record<string, string> = { ...element.attrs };
  for (const node of [element, ...descendants(element)]) {
    for (const name of LINK_ATTRIBUTES) if (node.attrs[name]) links.push(node.attrs[name]);
    for (const [name, value] of Object.entries(node.attrs)) {
      if ((name.startsWith("data-") || name === "datetime") && !(name in attrs)) attrs[name] = value;
    }
  }
  return { cells, links: [...new Set(links)], attrs, html: html.slice(element.start, element.end) };
}

const isHuntItem = (element: HtmlElement) => "data-hunt" in element.attrs || "data-hunt-id" in element.attrs || /(^|\s)hunt(-card|-item|-row)?(\s|$)/i.test(element.attrs.class ?? "");

/**
 * The hunt rows of a /hunts page: the table whose headers look like hunts (else the first table with rows), else
 * card-like elements (`[data-hunt]`, `.hunt`, `.hunt-card`), else the `li` items in `main`. Empty when none is found.
 */
export function extractHuntsPage(html: string): RawHuntsPage {
  const root = parseHtml(html);
  const all = [...descendants(root)];
  const tables = all.filter((element) => element.tag === "table");
  const tableRows = (table: HtmlElement) => [...descendants(table)].filter((element) => element.tag === "tr" && closest(element, "table") === table);
  const cellsOf = (row: HtmlElement) => row.children.filter((child): child is HtmlElement => typeof child !== "string" && (child.tag === "td" || child.tag === "th"));
  const read = (table: HtmlElement): RawHuntsPage => {
    const rows = tableRows(table);
    const headerRow = rows.find((row) => cellsOf(row).length > 0 && cellsOf(row).every((cell) => cell.tag === "th"));
    const headers = headerRow ? cellsOf(headerRow).map(textOf) : [];
    const body = rows.filter((row) => row !== headerRow && cellsOf(row).some((cell) => cell.tag === "td"));
    return { headers, rows: body.map((row) => rowOf(row, cellsOf(row).map(textOf), html)) };
  };
  if (tables.length > 0) {
    const pages = tables.map(read);
    return pages.find((page) => columnsFromHeaders(page.headers)) ?? pages.find((page) => page.rows.length > 0) ?? pages[0];
  }

  const scope = all.find((element) => element.tag === "main") ?? root;
  const scoped = [...descendants(scope)];
  let items = scoped.filter((element) => isHuntItem(element) && !hasAncestor(element, isHuntItem));
  if (items.length === 0 && scope !== root) items = scoped.filter((element) => element.tag === "li" && !element.parent?.parent?.tag.match(/^(nav|header|footer)$/));
  return { headers: [], rows: items.map((item) => rowOf(item, ownTexts(item), html)) };
}

function closest(element: HtmlElement, tag: string): HtmlElement | null {
  for (let node = element.parent; node; node = node.parent) if (node.tag === tag) return node;
  return null;
}

function hasAncestor(element: HtmlElement, test: (element: HtmlElement) => boolean): boolean {
  for (let node = element.parent; node; node = node.parent) if (test(node)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fields

type Field = "area" | "huntCode" | "qrCode" | "status" | "points" | "huntTime" | "location" | "accuracy";

/**
 * Header (or label) text per field, checked in this order; one column per field. "device" columns ("Apparaat", the
 * fox's phone) and our own group are recognised only to keep them from being read as the fox.
 */
const HEADER_PATTERNS: [Field | "ignore", RegExp][] = [
  ["ignore", /apparaat|device|toestel|telefoon|groep|group|hunter|gescand door/i],
  ["qrCode", /\bqr/i],
  ["huntCode", /code/i],
  ["accuracy", /nauwkeur|accura|precisie|afwijking/i],
  ["location", /locatie|location|positie|co[öo]rd|plaats|gps|kaart/i],
  ["huntTime", /tijd|time|datum|date|moment|geregistreerd|registratie|gescand/i],
  ["points", /punt|point|score/i],
  ["status", /status|beoordel|resultaat/i],
  ["area", /gebied|area|vos|team/i],
];

/** Column index per field from the header texts; null when no area or time column is recognised. */
export function columnsFromHeaders(headers: string[]): Partial<Record<Field, number>> | null {
  const columns: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const [field, pattern] of HEADER_PATTERNS) {
    const indexes = headers.flatMap((header, column) => (!used.has(column) && pattern.test(header.trim()) ? [column] : []));
    if (indexes.length === 0) continue;
    if (field === "ignore") {
      for (const index of indexes) used.add(index);
      continue;
    }
    columns[field] = indexes[0];
    used.add(indexes[0]);
  }
  return columns.area !== undefined && columns.huntTime !== undefined ? columns : null;
}

/** Whether a bare cell (no colon) reads as a label: short, no digits, not a fox name and not a status text */
const isBareLabel = (cell: string) => cell.length <= 20 && !/\d/.test(cell) && !AREA_WORD.test(cell) && classifyStatus(cell, 0) === "unknown";

function labelKind(label: string): Field | "ignore" | null {
  const text = label.trim().replace(/:$/, "");
  if (!text || text.length > 30 || /\d/.test(text)) return null;
  for (const [field, pattern] of HEADER_PATTERNS) if (pattern.test(text)) return field;
  return null;
}

/** "Label: value" cells and label cells followed by their value cell (definition lists, cards) */
function labeledValues(cells: string[]): Partial<Record<Field, string>> {
  const values: Partial<Record<Field, string>> = {};
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const pair = /^([^:]{2,30}):\s*(.*)$/.exec(cell);
    if (!pair && !isBareLabel(cell)) continue;
    const kind = labelKind(pair ? pair[1] : cell);
    if (!kind) continue;
    let value = pair ? pair[2].trim() : "";
    const next = cells[index + 1];
    if (!value && next !== undefined && !(/:$/.test(next) || (isBareLabel(next) && labelKind(next)))) {
      value = next.trim();
      index++;
    }
    if (kind !== "ignore" && value && !(kind in values)) values[kind] = value;
  }
  return values;
}

const AREA_WORD = /\b(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|oscar)\b/i;

/** "Vossenteam Alpha" → "alpha"; empty when the text names no fox team */
function areaOf(text: string): string {
  return AREA_WORD.exec(text)?.[1].toLowerCase() ?? "";
}

const PENDING = /wacht|bevestig|beoordeel|behandel|pending|open|nieuw/i;
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

function pointsOf(text: string): number | null {
  const match = /^\s*\+?(-?\d+)\s*(punten|punt|pnt|pts|points?)?\s*$/i.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** QR code from a label value, a "QR-code: X" text, a data attribute or a /qr/<code> link */
function qrCodeOf(texts: string[], links: string[], attrs: Record<string, string>): string | null {
  for (const name of ["data-qr", "data-qr-code", "data-qrcode", "data-qr-id"]) if (attrs[name]?.trim()) return attrs[name].trim();
  for (const text of texts) {
    const match = /\bqr(?:[- ]?(?:code|id))?\s*[:#]\s*([A-Za-z0-9][\w-]{2,})/i.exec(text);
    if (match) return match[1];
  }
  for (const link of links) {
    const match = /\/qr\/([A-Za-z0-9][\w-]{2,})/i.exec(link);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Time

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mrt: 2, maa: 2, mar: 2, apr: 3, mei: 4, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, dec: 11 };

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
 * "2026-10-17 21:03(:00)", "17-10-2026 21:03", "17/10/2026 21:03", "za 17 okt (2026) (om) 21:03", an ISO time with a
 * zone, or only "21:03". Null when not recognised.
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
  match = /^(?:[a-z]{2,9}\.?,?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(?:(\d{4}),?\s+)?(?:om\s+)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/i.exec(value);
  if (match && MONTHS[match[2].toLowerCase()] !== undefined) {
    const [, d, mo, y, h, mi, s] = match;
    return valid(new Date(y ? Number(y) : now.getFullYear(), MONTHS[mo.toLowerCase()], Number(d), Number(h), Number(mi), Number(s ?? 0)));
  }
  match = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(value);
  if (match) {
    const [h, mi, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    return h < 24 && mi < 60 ? recentClock(h, mi, s, now) : null;
  }
  return null;
}

/** A hunt time somewhere inside a longer text ("Geregistreerd op 17-10-2026 21:03"); the matched text and its time */
function findHuntTime(text: string, now: Date): { text: string; time: Date } | null {
  const whole = parseSiteHuntTime(text, now);
  if (whole) return { text: text.trim(), time: whole };
  const patterns = [
    /\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
    /\d{1,2}[-/.]\d{1,2}[-/.]\d{4},?\s+(?:om\s+)?\d{1,2}[:.]\d{2}(?::\d{2})?/,
    /\d{1,2}\s+[a-z]{3,9}\.?\s+(?:\d{4},?\s+)?(?:om\s+)?\d{1,2}[:.]\d{2}(?::\d{2})?/i,
    /(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    const time = found && parseSiteHuntTime(found[0], now);
    if (found && time) return { text: found[0].trim(), time };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Location

const inNetherlands = (lat: number, lng: number) => lat >= 50 && lat <= 54 && lng >= 3 && lng <= 8;
const number = (text: string | undefined) => (text === undefined ? NaN : Number.parseFloat(text.trim().replace(",", ".")));
const isLink = (text: string) => /^(https?:|\/|geo:|www\.)/i.test(text.trim()) || /[?&][\w-]+=/.test(text);

function point(latText: string | undefined, lngText: string | undefined): { lat: number; lng: number } | null {
  const [a, b] = [number(latText), number(lngText)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (inNetherlands(a, b)) return { lat: a, lng: b };
  if (inNetherlands(b, a)) return { lat: b, lng: a };
  return null;
}

const COORDINATE_PATTERNS = [
  // lat=…&lng=…, mlat/mlon, "lat": 52.1, "lng": 5.9
  /\bm?lat(?:itude)?["']?\s*[:=]\s*["']?(-?\d{1,3}(?:[.,]\d+)?)[\s\S]{0,60}?\b(?:m?lng|m?lon|long|longitude)["']?\s*[:=]\s*["']?(-?\d{1,3}(?:[.,]\d+)?)/gi,
  // Map links: ?q=, ll=, query=, center=, destination=
  /[?&](?:q|ll|sll|query|center|destination|daddr)=(?:loc:)?(-?\d{1,3}\.\d+)(?:,|%2C)\s*(?:\+)?(-?\d{1,3}\.\d+)/gi,
  // Google maps @lat,lng,zoom and geo: URIs
  /(?:@|geo:)(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/gi,
  // A pair in text: "52.0123, 5.9876", "52,0123 5,9876", "[52.05, 5.65]"
  /(?<![\w.,-])(\d{1,2}[.,]\d{2,})(?:\s*[,;]\s*|\s+)(\d{1,2}[.,]\d{2,})(?!\d)/g,
];

const ACCURACY_PATTERNS = [
  /(?:±|\+\/-|\+-)\s*(\d+(?:[.,]\d+)?)\s*(?:m|meter|meters)?\b/i,
  /(?:nauwkeurigheid|accuracy|precisie|afwijking)\D{0,20}?(\d+(?:[.,]\d+)?)\s*(?:m|meter|meters)?\b/i,
  /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:m|meter|meters)\b/i,
];

function accuracyOf(texts: string[]): number | null {
  for (const pattern of ACCURACY_PATTERNS) {
    for (const text of texts) {
      if (isLink(text)) continue;
      const match = pattern.exec(text);
      const value = match ? number(match[1]) : NaN;
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

const LAT_ATTRIBUTES = ["data-lat", "data-latitude", "lat", "latitude"];
const LNG_ATTRIBUTES = ["data-lng", "data-lon", "data-long", "data-longitude", "lng", "lon", "longitude"];
const ACCURACY_ATTRIBUTES = ["data-accuracy", "data-acc", "data-nauwkeurigheid", "accuracy"];
const LOCATION_ATTRIBUTES = ["data-location", "data-coords", "data-coordinates", "data-position", "data-latlng"];

/**
 * A location in the Netherlands (lat 50–54, lng 3–8) from data attributes (data-lat/data-lng/data-accuracy), cell
 * texts ("52.0123, 5.9876 (±12 m)", "52,0123 5,9876") or map links (?q=, @lat,lng, ll=, mlat/mlon). The accuracy comes
 * from a data attribute or a "±12 m" / "12 m" text, never from a link. Null when no coordinate pair is found.
 */
export function parseLocation(texts: string[], attrs: Record<string, string> = {}): ParsedLocation | null {
  const attr = (names: string[]) => names.map((name) => attrs[name]).find((value) => value !== undefined && value.trim() !== "");
  const attrAccuracy = number(attr(ACCURACY_ATTRIBUTES));
  const accuracy = () => (Number.isFinite(attrAccuracy) ? attrAccuracy : accuracyOf(texts));

  const fromAttrs = point(attr(LAT_ATTRIBUTES), attr(LNG_ATTRIBUTES));
  if (fromAttrs) return { ...fromAttrs, accuracy: accuracy() };
  const candidates = [...LOCATION_ATTRIBUTES.flatMap((name) => (attrs[name] ? [attrs[name]] : [])), ...texts];
  for (const pattern of COORDINATE_PATTERNS) {
    for (const text of candidates) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const found = point(match[1], match[2]);
        if (found) return { ...found, accuracy: accuracy() };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys

const normalizeCode = (code: string) => code.replace(/\s+/g, "");

/** The id in a hunt detail link ("/hunts/123", "https://…/hunt/abc-1?x"), or null */
function detailIdOf(url: string | null): string | null {
  if (!url) return null;
  const match = /\/hunts?\/([A-Za-z0-9][\w-]*)\/?(?:[?#]|$)/i.exec(url);
  return match ? match[1] : null;
}

/**
 * Key a scraped hunt is stored under, from the list page only (a detail page never changes it): its QR code, else its
 * old hunt code, else the id in its detail link, else area + time, else area + the raw time text.
 */
export function siteKeyOf(hunt: Pick<ScrapedHunt, "area" | "qrCode" | "huntCode" | "detailUrl" | "huntTime" | "huntTimeText">): string {
  if (hunt.qrCode) return `qr:${hunt.qrCode}`;
  if (hunt.huntCode) return `code:${hunt.huntCode}`;
  const id = detailIdOf(hunt.detailUrl);
  if (id) return `id:${id}`;
  const area = hunt.area.trim().toLowerCase();
  return hunt.huntTime ? `time:${area}:${hunt.huntTime.toISOString()}` : `raw:${area}:${hunt.huntTimeText.trim()}`;
}

/** Sets every hunt's siteKey; a key seen twice in one page (same fox, same minute, no code) gets a "#2" suffix. */
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
 * the same "#2" suffixes for duplicates. Other keys (QR code, hunt code, detail id) never change.
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
// Pages

/** A link to one hunt's own page: "/hunts/123", "https://www.jotihunt.nl/hunt/9f2c-…"; never another site */
const DETAIL_LINK = /^(?:https?:\/\/(?:www\.)?jotihunt\.nl)?\/?(?:[\w-]+\/)*hunts?\/[A-Za-z0-9-]*\d[\w-]*\/?(?:[?#].*)?$/i;

const POINTS_CELL = /^\s*\+?-?\d+\s*(punten|punt|pnt|pts|points?)\s*$/i;

function parseRow(row: RawHuntRow, columns: Partial<Record<Field, number>> | null, timeColumns: number[], now: Date): ScrapedHunt | null {
  const cells = row.cells.map(clean);
  const labeled = labeledValues(cells);
  const value = (field: Field): string | undefined => {
    const index = columns?.[field];
    return index === undefined ? labeled[field] : (cells[index] ?? "");
  };
  // Cells no known column claims, searched by content
  const claimed = new Set([...Object.values(columns ?? {}), ...timeColumns]);
  const free = cells.filter((_, index) => !claimed.has(index));

  const area = areaOf(value("area") ?? row.attrs["data-area"] ?? row.attrs["data-team"] ?? row.attrs["data-fox"] ?? "") || areaOf(free.find((cell) => AREA_WORD.test(cell)) ?? "");
  if (!area) return null;

  // Time: the time column(s) (date column first), else a datetime attribute, else any cell that holds a time
  const columnTime = timeColumns.length > 0 ? timeColumns.map((index) => cells[index] ?? "").filter(Boolean).join(" ") : value("huntTime");
  let huntTimeText = columnTime ?? "";
  let huntTime: Date | null = null;
  for (const source of [columnTime, row.attrs["datetime"], row.attrs["data-time"], row.attrs["data-hunt-time"], ...free]) {
    const found = source ? findHuntTime(source, now) : null;
    if (!found) continue;
    huntTime = found.time;
    huntTimeText = found.text;
    break;
  }
  huntTimeText = clean(huntTimeText);

  const pointsText = value("points") ?? row.attrs["data-points"] ?? free.find((cell) => POINTS_CELL.test(cell)) ?? "";
  const parsedPoints = pointsOf(pointsText) ?? (/\d/.test(pointsText) ? Number.parseInt(pointsText.replace(/[^\d-]/g, ""), 10) : 0);
  const points = Number.isFinite(parsedPoints) ? parsedPoints : 0;
  const statusText = clean(value("status") ?? row.attrs["data-status"] ?? free.find((cell) => cell.length < 60 && classifyStatus(cell, 0) !== "unknown") ?? "");

  const qrValue = value("qrCode");
  const qrCode = qrValue && /[A-Za-z0-9]/.test(qrValue) ? normalizeCode(qrValue) : qrCodeOf(cells, row.links, row.attrs);
  const codeValue = normalizeCode(value("huntCode") ?? row.attrs["data-code"] ?? "");
  const huntCode = /[A-Za-z0-9]/.test(codeValue) ? codeValue : null;
  const detailUrl = row.links.find((link) => DETAIL_LINK.test(link.trim()))?.trim() ?? null;

  // Location: the location column first, then any cell, link or attribute; the accuracy column wins
  let location = parseLocation([value("location"), ...cells, ...row.links].filter((text): text is string => !!text), row.attrs);
  const accuracyText = value("accuracy");
  const accuracy = accuracyText ? (accuracyOf([accuracyText]) ?? number(accuracyText.replace(/[^\d.,]/g, ""))) : NaN;
  if (location && Number.isFinite(accuracy)) location = { ...location, accuracy };

  return { siteKey: "", area, huntTime, huntTimeText, status: classifyStatus(statusText, points), statusText, points, qrCode, huntCode, location, detailUrl };
}

const headerList = (headers: string[]) => headers.map((header) => JSON.stringify(header.trim())).join(", ");

/**
 * Turn a hunts page into hunts. Columns are found by their header text; fields without a column are found by what the
 * cells look like. Rows without a fox (placeholders like "Nog geen hunts") are skipped. Never throws: an unknown layout
 * or rows that cannot be read give a `warning` (the caller logs it).
 */
export function parseHuntsPage(page: RawHuntsPage, now = new Date()): { hunts: ScrapedHunt[]; warning: string | null } {
  if (page.headers.length === 0 && page.rows.length === 0) return { hunts: [], warning: "No hunts table or hunt items found on the page" };
  const columns = columnsFromHeaders(page.headers);
  let warning: string | null = null;
  if (!columns && page.headers.some((header) => header.trim())) warning = `Unknown hunts layout (headers: ${headerList(page.headers)}); reading cells by their contents`;

  // A separate date and time column ("Datum", "Tijd") are read together, the date first
  const timePattern = HEADER_PATTERNS.find(([field]) => field === "huntTime")![1];
  const assigned = new Set(Object.values(columns ?? {}));
  const extraTimeColumns = columns ? page.headers.flatMap((header, index) => (!assigned.has(index) && timePattern.test(header.trim()) ? [index] : [])) : [];
  const timeColumns = extraTimeColumns.length > 0 && columns?.huntTime !== undefined ? [columns.huntTime, ...extraTimeColumns].sort((a, b) => Number(/datum|date/i.test(page.headers[b])) - Number(/datum|date/i.test(page.headers[a])) || a - b) : [];

  const hunts: ScrapedHunt[] = [];
  for (const row of page.rows) {
    try {
      const hunt = parseRow(row, columns, timeColumns, now);
      if (hunt) hunts.push(hunt);
    } catch (error) {
      warning ??= `A hunts row could not be read (${error instanceof Error ? error.message : String(error)}): ${row.html.slice(0, 300)}`;
    }
  }
  if (!warning && hunts.length === 0 && page.rows.some((row) => row.cells.filter((cell) => cell.trim()).length > 1)) {
    warning = `Hunts page has ${page.rows.length} row(s) but none could be read (headers: ${headerList(page.headers)})`;
  }
  return { hunts: assignSiteKeys(hunts), warning };
}

/** Location and QR code from a hunt's own page (the list may show neither). */
export function parseHuntDetail(html: string): { location: ParsedLocation | null; qrCode: string | null } {
  const root = parseHtml(html);
  const scope = [...descendants(root)].find((element) => element.tag === "main") ?? root;
  const row = rowOf(scope, ownTexts(scope), html);
  const elements = [scope, ...descendants(scope)];
  const sources = elements.flatMap((element) => (element.tag === "iframe" || element.tag === "img" ? [element.attrs.src ?? ""] : []));
  const scripts = [...descendants(root)].flatMap((element) => (element.tag === "script" && element.script ? [element.script] : []));
  const labeled = labeledValues(row.cells);

  let location: ParsedLocation | null = null;
  if (labeled.location) location = parseLocation([labeled.location], {});
  location ??= parseLocation([...row.cells, ...row.links, ...sources], row.attrs);
  location ??= parseLocation(scripts.filter((script) => script.length < 20_000));
  if (location && labeled.accuracy) {
    const accuracy = accuracyOf([labeled.accuracy]) ?? number(labeled.accuracy.replace(/[^\d.,]/g, ""));
    if (Number.isFinite(accuracy)) location = { ...location, accuracy };
  } else if (location && location.accuracy === null) {
    const accuracy = accuracyOf(row.cells);
    if (accuracy !== null) location = { ...location, accuracy };
  }

  const qrValue = labeled.qrCode;
  const qrCode = qrValue && /[A-Za-z0-9]/.test(qrValue) ? normalizeCode(qrValue) : qrCodeOf(row.cells, row.links, row.attrs);
  return { location, qrCode };
}
