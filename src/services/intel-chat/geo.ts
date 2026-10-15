import { distanceM } from "../prediction/geo";
import { formatRdAnswer, fromRd, toRd } from "../rd-answer";

export type LatLng = { lat: number; lng: number };
export type Rd = { x: number; y: number };
export type CoordinateKind = "rd" | "decimal" | "dms";

export interface ParsedCoordinate {
  kind: CoordinateKind;
  latLng: LatLng;
  rd: Rd;
}

export interface FormattedCoordinate {
  /** Jotihunt answer format in hectometres, "XXXX YYYY" */
  rd8: string;
  /** Full RD in metres, "XXXXXX YYYYYY" */
  rdFull: string;
  /** "52.01234, 5.87654" */
  decimal: string;
  /** Degrees and decimal minutes, "N 52° 00.740' E 5° 52.592'" */
  dm: string;
}

/** RD bounds parseRdAnswer accepts too (metres) */
const RD_X = [0, 290_000];
const RD_Y = [290_000, 630_000];
/** Digits per RD half: 4 = hectometres, 5 = decametres, 6 = metres */
const RD_SCALE: Record<number, number> = { 4: 100, 5: 10, 6: 1 };

const inRdBounds = ({ x, y }: Rd) => x >= RD_X[0] && x <= RD_X[1] && y >= RD_Y[0] && y <= RD_Y[1];
const validLatLng = ({ lat, lng }: LatLng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
/** A lat/lng pair written the other way round (lng first) is turned when only that order lands in the Netherlands */
const looksSwapped = (a: number, b: number) => a >= 2 && a <= 8 && b >= 50 && b <= 54;

/** RD: "1523 4311", "15234 43111", "152341 431112", "152.341/431.112", "15234311", "152341431112" (optionally "RD:" first) */
function parseRd(text: string): Rd | null {
  const cleaned = text
    .trim()
    .replace(/^rd\s*:?\s*/i, "")
    // thousands separators: "152.341" → "152341"
    .replace(/(\d)\.(\d{3})(?!\d)/g, "$1$2");
  const parts = cleaned.split(/[\s,;/]+/).filter(Boolean);
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  let xs: string;
  let ys: string;
  if (parts.length === 1 && [8, 10, 12].includes(parts[0].length)) {
    const half = parts[0].length / 2;
    xs = parts[0].slice(0, half);
    ys = parts[0].slice(half);
  } else if (parts.length === 2 && parts[0].length === parts[1].length && RD_SCALE[parts[0].length]) {
    [xs, ys] = parts;
  } else {
    return null;
  }
  const scale = RD_SCALE[xs.length];
  const rd = { x: Number(xs) * scale, y: Number(ys) * scale };
  return inRdBounds(rd) ? rd : null;
}

/** Decimal degrees: "52.0123, 5.8765", "52.0123 5.8765", "52,0123 5,8765" (lng first is turned round in NL) */
function parseDecimal(text: string): LatLng | null {
  const match =
    /^\s*(-?\d{1,3}\.\d+)\s*[,;\s/]\s*(-?\d{1,3}\.\d+)\s*$/.exec(text) ?? /^\s*(-?\d{1,3},\d+)\s*[;\s/]\s*(-?\d{1,3},\d+)\s*$/.exec(text);
  if (!match) return null;
  const a = Number(match[1].replace(",", "."));
  const b = Number(match[2].replace(",", "."));
  const latLng = looksSwapped(a, b) ? { lat: b, lng: a } : { lat: a, lng: b };
  return validLatLng(latLng) ? latLng : null;
}

/** Degrees (+ minutes (+ seconds)) of one half, e.g. "52° 12.345'" or "52 12 30" */
function dmsValue(half: string): number | null {
  const numbers = half.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length === 0 || numbers.length > 3) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (minutes >= 60 || seconds >= 60) return null;
  return degrees + minutes / 60 + seconds / 3600;
}

/**
 * Degrees with minutes (and seconds): "N 52° 12.345 E 005° 52.123", "52°12'30\"N 5°52'10\"E", "52°12,345' 5°52,123'".
 * Hemisphere letters N/S and E/O/W may come before or after each half.
 */
function parseDms(text: string): LatLng | null {
  const s = text.toUpperCase().replace(/(\d),(\d)/g, "$1.$2");
  const hasLetters = /[NS]/.test(s) && /[EOW]/.test(s);
  if (!hasLetters && !/[°º]/.test(s)) return null;
  let latHalf: string;
  let lngHalf: string;
  let latSign = 1;
  let lngSign = 1;
  if (hasLetters) {
    const letters = [...s.matchAll(/[NSEOW]/g)];
    if (letters.length !== 2) return null;
    const pieces = s.split(/[NSEOW]/);
    // "N 52 12.345 E 5 52.123" → ["", " 52 12.345 ", " 5 52.123"]: each half follows its letter
    const prefix = !/\d/.test(pieces[0]);
    const halves = prefix ? [pieces[1], pieces[2]] : [pieces[0], pieces[1]];
    const latFirst = /[NS]/.test(letters[0][0]);
    [latHalf, lngHalf] = latFirst ? halves : [halves[1], halves[0]];
    const latLetter = latFirst ? letters[0][0] : letters[1][0];
    const lngLetter = latFirst ? letters[1][0] : letters[0][0];
    if (!/[NS]/.test(latLetter) || !/[EOW]/.test(lngLetter)) return null;
    latSign = latLetter === "S" ? -1 : 1;
    lngSign = lngLetter === "W" ? -1 : 1;
  } else {
    const halves = s.split(/(?=\b\d+(?:\.\d+)?\s*[°º])/).filter((half) => /\d/.test(half));
    if (halves.length !== 2) return null;
    [latHalf, lngHalf] = halves;
  }
  const a = dmsValue(latHalf);
  const b = dmsValue(lngHalf);
  if (a === null || b === null) return null;
  const latLng = !hasLetters && looksSwapped(a, b) ? { lat: b, lng: a } : { lat: latSign * a, lng: lngSign * b };
  return validLatLng(latLng) ? latLng : null;
}

/** A coordinate in any format the team uses (RD, decimal degrees, degrees-minutes(-seconds)), or null */
export function parseCoordinate(input: string): ParsedCoordinate | null {
  const text = input.trim();
  if (!text || text.length > 100) return null;
  const dms = parseDms(text);
  if (dms) return { kind: "dms", latLng: dms, rd: toRd(dms.lng, dms.lat) };
  const decimal = parseDecimal(text);
  if (decimal) return { kind: "decimal", latLng: decimal, rd: toRd(decimal.lng, decimal.lat) };
  const rd = parseRd(text);
  if (rd) {
    const { lat, lng } = fromRd(rd.x, rd.y);
    return { kind: "rd", latLng: { lat, lng }, rd };
  }
  return null;
}

/** A point in WGS84 with its RD coordinates */
export function coordinateAt(latLng: LatLng): ParsedCoordinate {
  return { kind: "decimal", latLng, rd: toRd(latLng.lng, latLng.lat) };
}

function dm(value: number, positive: string, negative: string): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Number(((abs - degrees) * 60).toFixed(3));
  if (minutes >= 60) {
    degrees += 1;
    minutes = 0;
  }
  return `${value < 0 ? negative : positive} ${degrees}° ${minutes.toFixed(3).padStart(6, "0")}'`;
}

export function formatCoordinate({ latLng, rd }: ParsedCoordinate): FormattedCoordinate {
  const full = (value: number) => String(Math.round(value)).padStart(6, "0");
  return {
    rd8: formatRdAnswer(latLng.lng, latLng.lat),
    rdFull: `${full(rd.x)} ${full(rd.y)}`,
    decimal: `${latLng.lat.toFixed(5)}, ${latLng.lng.toFixed(5)}`,
    dm: `${dm(latLng.lat, "N", "S")} ${dm(latLng.lng, "E", "W")}`,
  };
}

/** Rough check: inside the bounding box of the Netherlands (not its border) */
export function insideNl({ lat, lng }: LatLng): boolean {
  return lat >= 50.75 && lat <= 53.56 && lng >= 3.36 && lng <= 7.23;
}

/** Metres between two points (great circle), rounded */
export function metresBetween(a: LatLng, b: LatLng): number {
  return Math.round(distanceM([a.lng, a.lat], [b.lng, b.lat]));
}

/** A scouting group as the geo helpers need it; `area` lowercase (e.g. "alpha") or null */
export interface AreaGroup {
  name: string;
  area: string | null;
  lat: number;
  lng: number;
}

export interface NearGroup {
  name: string;
  area: string | null;
  distanceM: number;
}

export interface AreaEstimate {
  area: string | null;
  method: "hull" | "nearest-group" | "none";
}

/** The `count` groups nearest to the point, nearest first */
export function nearestGroups(point: LatLng, groups: AreaGroup[], count: number): NearGroup[] {
  return groups
    .map((group) => ({ name: group.name, area: group.area, distanceM: metresBetween(point, group) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, count);
}

/** Groups within `radiusM` of the point, nearest first */
export function groupsWithin(point: LatLng, groups: AreaGroup[], radiusM: number): NearGroup[] {
  return nearestGroups(point, groups, groups.length).filter((group) => group.distanceM <= radiusM);
}

type Xy = [number, number];

const cross = (o: Xy, a: Xy, b: Xy) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeating the first point */
export function convexHull(points: Xy[]): Xy[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (sorted.length <= 2) return sorted;
  const lower: Xy[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Xy[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function segmentDistance(p: Xy, a: Xy, b: Xy): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance (in the plane's units) from a point to a convex hull (0 inside); a hull of 1 or 2 points is a point or segment */
export function distanceToHull(p: Xy, hull: Xy[]): number {
  if (hull.length === 0) return Infinity;
  if (hull.length === 1) return Math.hypot(p[0] - hull[0][0], p[1] - hull[0][1]);
  if (hull.length >= 3 && hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], p) >= 0)) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) best = Math.min(best, segmentDistance(p, hull[i], hull[(i + 1) % hull.length]));
  return best;
}

/** How far outside an area's group hull a point may lie and still count as inside (metres) */
export const HULL_BUFFER_M = 1000;

/**
 * Which area a point is probably in. Per area the convex hull of its groups (in RD metres) buffered by 1 km: inside
 * exactly one → that area (`hull`). Otherwise the area of the nearest group with an area (`nearest-group`). No group
 * has an area → `none`.
 */
export function estimateArea(point: LatLng, groups: AreaGroup[]): AreaEstimate {
  const withArea = groups.filter((group): group is AreaGroup & { area: string } => group.area !== null);
  if (withArea.length === 0) return { area: null, method: "none" };
  const rdOf = (latLng: LatLng): Xy => {
    const { x, y } = toRd(latLng.lng, latLng.lat);
    return [x, y];
  };
  const byArea = new Map<string, Xy[]>();
  for (const group of withArea) byArea.set(group.area, [...(byArea.get(group.area) ?? []), rdOf(group)]);
  const p = rdOf(point);
  const inside = [...byArea].filter(([, points]) => distanceToHull(p, convexHull(points)) <= HULL_BUFFER_M).map(([area]) => area);
  if (inside.length === 1) return { area: inside[0], method: "hull" };
  return { area: nearestGroups(point, withArea, 1)[0].area, method: "nearest-group" };
}
