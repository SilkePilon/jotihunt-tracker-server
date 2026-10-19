import { amsterdamHalf, legIsNight, swapWindow } from "./sun";

export type LegMode = "walk" | "car" | "extra";
export type LegReason = "manual" | "status-red" | "status-orange" | "too-fast" | "walk";
export interface LegInput { fromId: string; toId: string; from: Date; to: Date; fromCoord: [number, number]; toCoord: [number, number]; override?: "walk" | "car" | null; walkDurationS: number | null }
export interface StatusEvent { status: string; at: Date }
export interface ClassifiedLeg extends LegInput { mode: LegMode; reason: LegReason; manual: boolean; night: boolean; redFrom?: Date; redTo?: Date }

/** Walking must take more than this many times the elapsed time before a leg counts as "too fast to walk". */
export const SPEED_RATIO = 1.5;
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

/** Parts of `interval` outside the swap windows at the start of the halves it touches. */
function withoutSwaps(interval: Interval): Interval[] {
  const windows = [swapWindow(interval.from), swapWindow(interval.to)];
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
  for (const interval of intervals) {
    const o = overlap(leg, interval);
    if (o && o.to.getTime() - o.from.getTime() >= MIN_OVERLAP_MS && (!best || o.to.getTime() - o.from.getTime() > best.to.getTime() - best.from.getTime())) best = o;
  }
  return best;
}

export function legNight(leg: Pick<LegInput, "from" | "to" | "fromCoord" | "toCoord">): boolean {
  const lng = (leg.fromCoord[0] + leg.toCoord[0]) / 2;
  const lat = (leg.fromCoord[1] + leg.toCoord[1]) / 2;
  return legIsNight(leg.from, leg.to, lat, lng);
}

const elapsedS = (leg: LegInput) => Math.max(1, (leg.to.getTime() - leg.from.getTime()) / 1000);
const speedRatio = (leg: LegInput) => (leg.walkDurationS ?? 0) / elapsedS(leg);

export function classifyLegs(legs: LegInput[], events: StatusEvent[], now: Date = new Date()): ClassifiedLeg[] {
  const intervals = statusIntervals(events, now);
  const red = intervals.filter((i) => i.status === "red").flatMap(withoutSwaps);
  const orange = intervals.filter((i) => i.status === "orange");

  const out: ClassifiedLeg[] = legs.map((leg) => {
    const base = { ...leg, night: legNight(leg), manual: false };
    if (leg.override) return { ...base, mode: leg.override, reason: "manual", manual: true };
    const span = { from: leg.from, to: leg.to };
    const redHit = longestOverlap(span, red);
    if (redHit) return { ...base, mode: "car", reason: "status-red", redFrom: redHit.from, redTo: redHit.to };
    if (longestOverlap(span, orange)) return { ...base, mode: "extra", reason: "status-orange" };
    if (leg.walkDurationS !== null && speedRatio(leg) > SPEED_RATIO) return { ...base, mode: "car", reason: "too-fast" };
    return { ...base, mode: "walk", reason: "walk" };
  });

  // At most one big move per half: manual car > longest red > fastest "too fast"
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
      [...candidates].sort((a, b) => speedRatio(b) - speedRatio(a))[0];
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
