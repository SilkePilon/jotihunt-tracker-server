import distance from "@turf/distance";
import { amsterdamHalf, legIsNight, swapWindow } from "./sun";

export type LegMode = "walk" | "car" | "extra";
export type LegReason = "manual" | "status-red" | "status-orange" | "too-fast" | "walk";
export interface LegInput { fromId: string; toId: string; from: Date; to: Date; fromCoord: [number, number]; toCoord: [number, number]; override?: "walk" | "car" | null; walkDurationS: number | null }
export interface StatusEvent { status: string; at: Date }
export interface ClassifiedLeg extends LegInput { mode: LegMode; reason: LegReason; manual: boolean; night: boolean; redFrom?: Date; redTo?: Date }

/** Walking must take more than this many times the elapsed time before a leg counts as "too fast to walk". */
export const SPEED_RATIO = 1.5;
/** Short or quick legs (GPS/hint jitter, markers with the same time) are never "too fast to walk". */
export const MIN_FAST_ELAPSED_S = 600;
export const MIN_FAST_DISTANCE_KM = 3;
const MIN_OVERLAP_MS = 60_000;

interface Interval { from: Date; to: Date }

/** Each status lasts from its event until the next one (the last one until `until`). */
export function statusIntervals(events: StatusEvent[], until: Date): { status: string; from: Date; to: Date }[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  return sorted.map((event, i) => ({ status: event.status, from: event.at, to: sorted[i + 1]?.at ?? until }));
}

function overlap(a: Interval, b: Interval): Interval | null {
  const from = Math.max(a.from.getTime(), b.from.getTime());
  const to = Math.min(a.to.getTime(), b.to.getTime());
  return to > from ? { from: new Date(from), to: new Date(to) } : null;
}

/** Swap windows starting before `to`, beginning with the one of the half containing `from`. Stepping 36 h from a window start always lands in the next half, even on 23 h / 25 h DST days. */
export function swapWindowsBetween(from: Date, to: Date): { start: Date; end: Date }[] {
  const windows: { start: Date; end: Date }[] = [];
  let w = swapWindow(from);
  while (w.start < to) {
    windows.push(w);
    const next = swapWindow(new Date(w.start.getTime() + 36 * 3600_000));
    if (next.start.getTime() <= w.start.getTime()) break;
    w = next;
  }
  return windows;
}

/** Parts of `interval` outside every swap window it touches. */
function withoutSwaps(interval: Interval): Interval[] {
  const windows = swapWindowsBetween(interval.from, interval.to);
  let parts: Interval[] = [interval];
  for (const w of windows) {
    parts = parts.flatMap((part) => {
      if (!overlap(part, { from: w.start, to: w.end })) return [part];
      const out: Interval[] = [];
      if (part.from < w.start) out.push({ from: part.from, to: w.start });
      if (part.to > w.end) out.push({ from: w.end, to: part.to });
      return out;
    });
  }
  return parts;
}

function longestOverlap(leg: Interval, intervals: Interval[]): Interval | null {
  let best: Interval | null = null;
  let bestMs = MIN_OVERLAP_MS - 1;
  for (const interval of intervals) {
    const o = overlap(leg, interval);
    if (!o) continue;
    const ms = o.to.getTime() - o.from.getTime();
    if (ms > bestMs) { best = o; bestMs = ms; }
  }
  return best;
}

export function legNight(leg: Pick<LegInput, "from" | "to" | "fromCoord" | "toCoord">): boolean {
  const lng = (leg.fromCoord[0] + leg.toCoord[0]) / 2;
  const lat = (leg.fromCoord[1] + leg.toCoord[1]) / 2;
  return legIsNight(leg.from, leg.to, lat, lng);
}

const elapsedS = (leg: LegInput) => Math.max(1, (leg.to.getTime() - leg.from.getTime()) / 1000);
/** How much longer walking takes than the time the fox actually had. */
const excessS = (leg: LegInput) => (leg.walkDurationS ?? 0) - elapsedS(leg);
function tooFast(leg: LegInput): boolean {
  if (leg.walkDurationS === null) return false;
  const elapsed = (leg.to.getTime() - leg.from.getTime()) / 1000;
  if (elapsed < MIN_FAST_ELAPSED_S) return false;
  if (distance(leg.fromCoord, leg.toCoord, { units: "kilometers" }) < MIN_FAST_DISTANCE_KM) return false;
  return leg.walkDurationS > SPEED_RATIO * elapsed;
}

export function classifyLegs(legs: LegInput[], events: StatusEvent[], now: Date = new Date()): ClassifiedLeg[] {
  const intervals = statusIntervals(events, now);
  const red = intervals.filter((i) => i.status === "red").flatMap(withoutSwaps);
  const orange = intervals.filter((i) => i.status === "orange");

  const out: ClassifiedLeg[] = legs.map((leg) => {
    const base = { ...leg, night: legNight(leg), manual: false };
    if (leg.override) return { ...base, mode: leg.override, reason: "manual", manual: true };
    // Across the swap a new team starts near the old end point: always a walking leg
    if (amsterdamHalf(leg.from) !== amsterdamHalf(leg.to)) return { ...base, mode: "walk", reason: "walk" };
    const span = { from: leg.from, to: leg.to };
    const redHit = longestOverlap(span, red);
    if (redHit) return { ...base, mode: "car", reason: "status-red", redFrom: redHit.from, redTo: redHit.to };
    if (longestOverlap(span, orange)) return { ...base, mode: "extra", reason: "status-orange" };
    if (tooFast(leg)) return { ...base, mode: "car", reason: "too-fast" };
    return { ...base, mode: "walk", reason: "walk" };
  });

  // At most one big move per half: manual car > longest red > "too fast" with the most excess time
  const byHalf = new Map<string, ClassifiedLeg[]>();
  for (const leg of out) {
    if (leg.mode !== "car") continue;
    const key = amsterdamHalf(leg.from);
    let list = byHalf.get(key);
    if (!list) byHalf.set(key, (list = []));
    list.push(leg);
  }
  for (const candidates of byHalf.values()) {
    const redLength = (l: ClassifiedLeg) => (l.redTo && l.redFrom ? l.redTo.getTime() - l.redFrom.getTime() : 0);
    const keep =
      candidates.find((l) => l.manual) ??
      [...candidates].filter((l) => l.reason === "status-red").sort((a, b) => redLength(b) - redLength(a))[0] ??
      [...candidates].sort((a, b) => excessS(b) - excessS(a))[0];
    for (const leg of candidates) {
      if (leg === keep || leg.manual) continue;
      leg.mode = "walk";
      leg.reason = "walk";
      delete leg.redFrom;
      delete leg.redTo;
    }
  }
  return out;
}
