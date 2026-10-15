import destination from "@turf/destination";
import { bearingDeg, distanceM } from "../prediction/geo";
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

/** Compass bearing from a to b, 0-360 degrees (0 = north), rounded to 0.1 */
export function bearingBetween(a: LatLng, b: LatLng): number {
  return Math.round(((bearingDeg([a.lng, a.lat], [b.lng, b.lat]) + 360) % 360) * 10) / 10;
}

/** The point `distanceM` metres from `from` in compass direction `bearing` (degrees, 0 = north; great circle) */
export function projectFrom(from: LatLng, bearing: number, metres: number): LatLng {
  const [lng, lat] = destination([from.lng, from.lat], metres, bearing, { units: "meters" }).geometry.coordinates;
  return { lat, lng };
}

// --- Intersections (kruispeiling, cirkels) in RD ----------------------------------------------------------------

export interface BearingLine {
  from: LatLng;
  /** Compass bearing (true north), degrees */
  bearingDeg: number;
}

export interface Circle {
  center: LatLng;
  radiusM: number;
}

export interface IntersectResult {
  points: ParsedCoordinate[];
  note?: string;
}

type Ray = { kind: "ray"; p: Xy; d: Xy };
type Ring = { kind: "ring"; c: Xy; r: number };
type Shape = Ray | Ring;

const MAX_CANDIDATES = 2;
/** Lines closer to parallel than this (sine of the angle between them) do not meet */
const PARALLEL_SIN = Math.sin((0.5 * Math.PI) / 180);
/** Circles (or a line and a circle) this close to touching count as touching: RD is not exactly metres */
const TOUCH_TOLERANCE = (size: number) => Math.max(5, size * 0.001);
const SAME_POINT_M = 1;
const APPROXIMATE_M = 50;

const NOTES = {
  parallel: "De peilingen lopen evenwijdig; er is geen snijpunt",
  behind: "De peilingen snijden alleen achter een startpunt; er is geen snijpunt",
  circles: "De cirkels raken elkaar niet; er is geen snijpunt",
  lineCircle: "De peiling raakt de cirkel niet; er is geen snijpunt",
} as const;

const rdXy = (latLng: LatLng): Xy => {
  const { x, y } = toRd(latLng.lng, latLng.lat);
  return [x, y];
};
const sub = (p: Xy, q: Xy): Xy => [p[0] - q[0], p[1] - q[1]];
const perpDot = (p: Xy, q: Xy) => p[0] * q[1] - p[1] * q[0];
const dot = (p: Xy, q: Xy) => p[0] * q[0] + p[1] * q[1];
const along = (p: Xy, d: Xy, t: number): Xy => [p[0] + d[0] * t, p[1] + d[1] * t];

/** A bearing as a ray in RD: the true bearing turned into the grid direction by projecting 1 km along it */
function rayOf(line: BearingLine): Ray {
  const p = rdXy(line.from);
  const q = rdXy(projectFrom(line.from, ((line.bearingDeg % 360) + 360) % 360, 1000));
  const d = sub(q, p);
  const length = Math.hypot(d[0], d[1]);
  return { kind: "ray", p, d: [d[0] / length, d[1] / length] };
}

type PairResult = { points: Xy[]; note?: string };

function rayRay(a: Ray, b: Ray): PairResult {
  const denominator = perpDot(a.d, b.d);
  if (Math.abs(denominator) < PARALLEL_SIN) return { points: [], note: NOTES.parallel };
  const between = sub(b.p, a.p);
  const ta = perpDot(between, b.d) / denominator;
  const tb = perpDot(between, a.d) / denominator;
  if (ta < 0 || tb < 0) return { points: [], note: NOTES.behind };
  return { points: [along(a.p, a.d, ta)] };
}

function ringRing(a: Ring, b: Ring): PairResult {
  const between = sub(b.c, a.c);
  const d = Math.hypot(between[0], between[1]);
  const tolerance = TOUCH_TOLERANCE(a.r + b.r);
  if (d < SAME_POINT_M || d > a.r + b.r + tolerance || d < Math.abs(a.r - b.r) - tolerance) return { points: [], note: NOTES.circles };
  const unit: Xy = [between[0] / d, between[1] / d];
  // Touching (outside or inside): one point on the line through both centres
  if (Math.abs(d - (a.r + b.r)) <= tolerance) return { points: [along(a.c, unit, a.r + (d - a.r - b.r) / 2)] };
  if (Math.abs(d - Math.abs(a.r - b.r)) <= tolerance) return { points: [along(a.c, unit, a.r >= b.r ? a.r : -a.r)] };
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const base = along(a.c, unit, x);
  return {
    points: [
      [base[0] - unit[1] * h, base[1] + unit[0] * h],
      [base[0] + unit[1] * h, base[1] - unit[0] * h],
    ],
  };
}

function rayRing(a: Ray, b: Ring): PairResult {
  // Foot of the perpendicular from the centre on the line
  const t0 = dot(sub(b.c, a.p), a.d);
  const foot = along(a.p, a.d, t0);
  const offset = Math.hypot(foot[0] - b.c[0], foot[1] - b.c[1]);
  const tolerance = TOUCH_TOLERANCE(b.r);
  if (offset > b.r + tolerance) return { points: [], note: NOTES.lineCircle };
  const half = offset >= b.r ? 0 : Math.sqrt(b.r * b.r - offset * offset);
  const ts = half < SAME_POINT_M ? [t0] : [t0 - half, t0 + half];
  const forward = ts.filter((t) => t >= 0);
  return forward.length > 0 ? { points: forward.map((t) => along(a.p, a.d, t)) } : { points: [], note: NOTES.lineCircle };
}

function pair(a: Shape, b: Shape): PairResult {
  if (a.kind === "ray" && b.kind === "ray") return rayRay(a, b);
  if (a.kind === "ring" && b.kind === "ring") return ringRing(a, b);
  return a.kind === "ray" ? rayRing(a, b as Ring) : rayRing(b as Ray, a);
}

/** The point closest to all lines (least squares on the perpendicular distances), null when they are (nearly) parallel */
function leastSquares(rays: Ray[]): Xy | null {
  let [m00, m01, m11, b0, b1] = [0, 0, 0, 0, 0];
  for (const { p, d } of rays) {
    // I - d dᵀ projects onto the line's normal
    const [n00, n01, n11] = [1 - d[0] * d[0], -d[0] * d[1], 1 - d[1] * d[1]];
    m00 += n00;
    m01 += n01;
    m11 += n11;
    b0 += n00 * p[0] + n01 * p[1];
    b1 += n01 * p[0] + n11 * p[1];
  }
  const determinant = m00 * m11 - m01 * m01;
  if (Math.abs(determinant) < 1e-9) return null;
  return [(m11 * b0 - m01 * b1) / determinant, (m00 * b1 - m01 * b0) / determinant];
}

/** How far a point is from a shape: from a ray (its start when the point lies behind it) or a circle line */
function miss(point: Xy, shape: Shape): number {
  if (shape.kind === "ring") return Math.abs(Math.hypot(point[0] - shape.c[0], point[1] - shape.c[1]) - shape.r);
  const t = dot(sub(point, shape.p), shape.d);
  const closest = t < 0 ? shape.p : along(shape.p, shape.d, t);
  return Math.hypot(point[0] - closest[0], point[1] - closest[1]);
}

const rdPoint = ([x, y]: Xy): ParsedCoordinate => {
  const { lat, lng } = fromRd(x, y);
  return { kind: "rd", latLng: { lat, lng }, rd: { x, y } };
};

/**
 * Where bearing lines (kruispeiling) and/or circles (a distance from a point) meet, computed in the RD plane: at most 2
 * candidates, best fit first. Bearings are rays: a crossing behind a start point does not count. With only `points`:
 * their centroid. `note` (Dutch) explains an empty result or a crossing that is only approximate.
 */
export function intersectRd({ bearings = [], circles = [], points = [] }: { bearings?: BearingLine[]; circles?: Circle[]; points?: LatLng[] }): IntersectResult {
  if (bearings.length + circles.length === 0) {
    if (points.length === 0) return { points: [] };
    const xy = points.map(rdXy);
    const centroid: Xy = [xy.reduce((sum, p) => sum + p[0], 0) / xy.length, xy.reduce((sum, p) => sum + p[1], 0) / xy.length];
    return { points: [rdPoint(centroid)], note: `Middelpunt van ${points.length} punten` };
  }
  const rays = bearings.map(rayOf);
  const shapes: Shape[] = [...rays, ...circles.map((circle): Ring => ({ kind: "ring", c: rdXy(circle.center), r: circle.radiusM }))];
  const candidates: Xy[] = [];
  let firstNote: string | undefined;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const result = pair(shapes[i], shapes[j]);
      candidates.push(...result.points);
      firstNote ??= result.note;
    }
  }
  if (rays.length >= 3) {
    const best = leastSquares(rays);
    if (best && rays.every((ray) => dot(sub(best, ray.p), ray.d) >= 0)) candidates.push(best);
  }
  if (candidates.length === 0) return { points: [], note: firstNote };

  const scored = candidates
    .map((point, index) => ({ point, index, error: shapes.reduce((sum, shape) => sum + miss(point, shape) ** 2, 0) }))
    .sort((p, q) => p.error - q.error || p.index - q.index);
  const chosen: typeof scored = [];
  for (const candidate of scored) {
    if (chosen.length === MAX_CANDIDATES) break;
    if (chosen.every((other) => Math.hypot(other.point[0] - candidate.point[0], other.point[1] - candidate.point[1]) > SAME_POINT_M)) chosen.push(candidate);
  }
  const worstMiss = Math.max(...shapes.map((shape) => miss(chosen[0].point, shape)));
  const note = worstMiss > APPROXIMATE_M ? `De lijnen en cirkels komen niet precies samen; beste benadering (afwijking tot ${Math.round(worstMiss)} m)` : undefined;
  return { points: chosen.map(({ point }) => rdPoint(point)), ...(note ? { note } : {}) };
}
