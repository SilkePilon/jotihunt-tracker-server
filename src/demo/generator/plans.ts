import { HintCellStatus, HintCheck } from "../../models/hint-cell.model";
import { DEMO_AREAS, HINT_NOTES, HOUR_MS, LETTER_AREAS, MINUTE_MS, OSCAR, type DemoArea } from "./constants";
import type { Rng } from "./prng";

// --- Area statuses ----------------------------------------------------------------------------------------------

export type AreaStatus = "green" | "orange" | "red";

export interface AreaPlan {
  name: DemoArea;
  status: AreaStatus;
  updatedAt: Date;
}

/** 6 green (incl. Oscar), 1 orange (onderweg), 2 red; updatedAt spread over the last hours. */
export function planAreas(now: Date, rng: Rng): AreaPlan[] {
  const letters = rng.shuffle(LETTER_AREAS);
  const statusOf = new Map<DemoArea, AreaStatus>([[OSCAR, "green"]]);
  letters.forEach((area, index) => statusOf.set(area, index < 2 ? "red" : index === 2 ? "orange" : "green"));
  return DEMO_AREAS.map((name) => ({ name, status: statusOf.get(name)!, updatedAt: new Date(now.getTime() - rng.int(8, 300) * MINUTE_MS) }));
}

// --- Hint cells -------------------------------------------------------------------------------------------------

/** Age class of a hint: the newest one, the one before it, and the older ones. */
export type HintPhase = "newest" | "recent" | "old";

export function hintPhase(rankFromNewest: number): HintPhase {
  return rankFromNewest === 0 ? "newest" : rankFromNewest === 1 ? "recent" : "old";
}

export interface HintInput {
  articleId: number;
  title: string;
  slotTime: Date;
}

export interface CellInput {
  articleId: number;
  /** lowercase */
  area: string;
  status: string;
}

export interface NotePlan {
  user: number;
  text: string;
  at: Date;
}

export interface CellPlan {
  articleId: number;
  area: string;
  status: HintCellStatus;
  /** Index into the demo users */
  claimedBy?: number;
  claimedAt?: Date;
  check?: HintCheck;
  checkedBy?: number;
  notes: NotePlan[];
}

function clampToNow(time: number, now: Date): Date {
  return new Date(Math.min(time, now.getTime() - MINUTE_MS));
}

function otherUser(user: number, userCount: number, rng: Rng): number {
  return (user + rng.int(1, userCount - 1)) % userCount;
}

/**
 * Plan the state of every hint cell:
 * - old hints: solved, checked "Klopt" except exactly one "Twijfel";
 * - the hint before the newest: a mix of solved and solving;
 * - the newest hint: open except one solving; red areas "none".
 * A hint titled "Hint <area>" only concerns that area (the others become "none"); cells the article marks "-" stay "none".
 * Every hint gets 1–3 notes on some cells. All times are ≤ now.
 */
export function planHintCells(input: { hints: HintInput[]; cells: CellInput[]; redAreas: string[]; now: Date; userCount: number; rng: Rng }): CellPlan[] {
  const { now, userCount, rng } = input;
  const red = new Set(input.redAreas.map((area) => area.toLowerCase()));
  const byNewest = [...input.hints].sort((a, b) => b.slotTime.getTime() - a.slotTime.getTime());
  const plans: CellPlan[] = [];

  byNewest.forEach((hint, rank) => {
    const phase = hintPhase(rank);
    const titled = /^hint\s+(\w+)$/i.exec(hint.title.trim())?.[1]?.toLowerCase();
    const onlyArea = DEMO_AREAS.some((area) => area.toLowerCase() === titled) ? titled : undefined;
    const cells = input.cells.filter((cell) => cell.articleId === hint.articleId).sort((a, b) => a.area.localeCompare(b.area));
    const slot = hint.slotTime.getTime();
    const hintPlans: CellPlan[] = cells.map((cell) => {
      const none = cell.status === HintCellStatus.None || (onlyArea !== undefined && cell.area !== onlyArea) || (phase === "newest" && red.has(cell.area));
      return { articleId: cell.articleId, area: cell.area, status: none ? HintCellStatus.None : HintCellStatus.Open, notes: [] };
    });
    const active = hintPlans.filter((plan) => plan.status !== HintCellStatus.None);
    const claim = (plan: CellPlan, status: HintCellStatus) => {
      plan.status = status;
      plan.claimedBy = rng.int(0, userCount - 1);
      plan.claimedAt = clampToNow(slot + rng.int(4, 45) * MINUTE_MS, now);
    };

    if (phase === "old") {
      for (const plan of active) {
        claim(plan, HintCellStatus.Solved);
        plan.check = HintCheck.Verified;
        plan.checkedBy = otherUser(plan.claimedBy!, userCount, rng);
      }
    } else if (phase === "recent") {
      const shuffled = rng.shuffle(active);
      const solvedCount = Math.max(1, Math.round(shuffled.length * 0.6));
      shuffled.forEach((plan, index) => {
        if (index < solvedCount) {
          claim(plan, HintCellStatus.Solved);
          if (rng.chance(0.5)) {
            plan.check = HintCheck.Verified;
            plan.checkedBy = otherUser(plan.claimedBy!, userCount, rng);
          } else {
            plan.check = HintCheck.Unchecked;
          }
        } else {
          claim(plan, HintCellStatus.Solving);
        }
      });
    } else if (active.length) {
      claim(rng.pick(active), HintCellStatus.Solving);
    }

    // Notes: 1–3 per hint, on cells that are not "none"
    const noteCount = active.length ? rng.int(1, Math.min(3, active.length)) : 0;
    for (const plan of rng.shuffle(active).slice(0, noteCount)) {
      plan.notes.push({ user: rng.int(0, userCount - 1), text: rng.pick(HINT_NOTES), at: clampToNow(slot + rng.int(3, 50) * MINUTE_MS, now) });
    }
    plans.push(...hintPlans);
  });

  // Exactly one "Twijfel" among the old hints
  const oldSolved = plans.filter((plan) => plan.check === HintCheck.Verified && byNewest.findIndex((hint) => hint.articleId === plan.articleId) >= 2);
  if (oldSolved.length) rng.pick(oldSolved).check = HintCheck.Disputed;
  return plans;
}

// --- Hunt reports -----------------------------------------------------------------------------------------------

export type HuntKind = "judged" | "submitted" | "to_submit" | "overdue" | "review";

export interface HuntPlan {
  kind: HuntKind;
  /** Area name as in DEMO_AREAS */
  area: DemoArea;
  huntTime: Date;
  createdAt: Date;
  reporter: number;
  sticker: number;
  codeConfidence: number;
  timeConfidence: number;
  submittedAt?: Date;
  submittedBy?: number;
  site?: { status: string; points: number; seenAt: Date };
}

/** Minimum time between two hunts on the same fox (they can't be hunted again right away). */
export const HUNT_COOLDOWN_MS = HOUR_MS;

/** Target age in minutes per report, oldest first. */
const HUNT_SLOTS: { kind: HuntKind; ageMin: number; points?: number }[] = [
  { kind: "judged", ageMin: 310, points: 10 },
  { kind: "judged", ageMin: 265, points: 5 },
  { kind: "judged", ageMin: 225, points: 10 },
  { kind: "submitted", ageMin: 180 },
  { kind: "submitted", ageMin: 140 },
  { kind: "submitted", ageMin: 100 },
  { kind: "overdue", ageMin: 55 },
  { kind: "review", ageMin: 26 },
  { kind: "to_submit", ageMin: 17 },
  { kind: "to_submit", ageMin: 6 },
];

function toMinute(time: number): Date {
  const date = new Date(time);
  date.setSeconds(0, 0);
  return date;
}

/**
 * 10 hunt reports: 3 judged ("Goedgekeurd", 10/5 points), 3 submitted, 1 overdue, 1 needing review (low
 * confidence, recent) and 2 still to submit. Hunts on the same fox are at least an hour apart; all times ≤ now.
 */
export function planHuntReports(input: { now: Date; huntStart: Date; areas: DemoArea[]; userCount: number; stickerCount: number; rng: Rng }): HuntPlan[] {
  const { now, rng } = input;
  if (input.areas.length === 0) return [];
  const lastHunt = new Map<DemoArea, number>();
  const stickers = rng.shuffle(Array.from({ length: input.stickerCount }, (_, index) => index));
  return HUNT_SLOTS.map((slot, index) => {
    const jitter = slot.kind === "to_submit" || slot.kind === "review" ? rng.int(-2, 2) : rng.int(-6, 6);
    const huntTime = toMinute(Math.max(input.huntStart.getTime() + 5 * MINUTE_MS, now.getTime() - (slot.ageMin + jitter) * MINUTE_MS));
    const free = input.areas.filter((area) => huntTime.getTime() - (lastHunt.get(area) ?? -Infinity) >= HUNT_COOLDOWN_MS);
    const area = rng.pick(free.length ? free : input.areas);
    lastHunt.set(area, huntTime.getTime());
    const createdAt = new Date(Math.min(huntTime.getTime() + rng.int(40, 150) * 1000, now.getTime()));
    const plan: HuntPlan = {
      kind: slot.kind,
      area,
      huntTime,
      createdAt,
      reporter: rng.int(0, input.userCount - 1),
      sticker: stickers[index % stickers.length],
      codeConfidence: slot.kind === "review" ? 0.55 : Math.round(rng.range(0.9, 0.99) * 100) / 100,
      timeConfidence: Math.round(rng.range(0.9, 0.99) * 100) / 100,
    };
    if (slot.kind === "judged" || slot.kind === "submitted") {
      plan.submittedAt = new Date(Math.min(huntTime.getTime() + rng.int(4, 18) * MINUTE_MS, now.getTime()));
      plan.submittedBy = rng.int(0, input.userCount - 1);
    }
    if (slot.kind === "judged") plan.site = { status: "Goedgekeurd", points: slot.points!, seenAt: new Date(Math.min(plan.submittedAt!.getTime() + 20 * MINUTE_MS, now.getTime())) };
    return plan;
  });
}

// --- Spots ------------------------------------------------------------------------------------------------------

export interface SpotPlan {
  area: DemoArea;
  time: Date;
}

/** 4 spots of foxes (not on red areas) in the last 4 hours. */
export function planSpots(now: Date, areas: DemoArea[], rng: Rng, count = 4): SpotPlan[] {
  if (areas.length === 0) return [];
  return Array.from({ length: count }, () => ({ area: rng.pick(areas), time: toMinute(now.getTime() - rng.int(10, 240) * MINUTE_MS) }));
}
