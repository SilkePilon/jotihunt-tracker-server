import { DWELL_RANGE, EMA_ALPHA, SPEED_FACTOR_RANGE, TOP_CANDIDATES, WALK_M_PER_MIN, WEIGHT_RANGE, WEIGHT_STEP } from "./constants";
import type { TermValues, Weights } from "./types";

export interface Accuracy {
  top1Hits: number;
  top3Hits: number;
  evaluations: number;
}

export interface SnapshotCandidate {
  teamApiId: number;
  probability: number;
  terms: TermValues;
}

/** Only learn speed from routes of at least this length (standing still says nothing about speed). */
export const MIN_SPEED_SAMPLE_DISTANCE_M = 500;
/** Skip speed samples across long gaps (breaks, swaps). */
export const MAX_SPEED_SAMPLE_GAP_MIN = 180;
export const MIN_MOVING_MINUTES = 5;
export const MAX_DWELL_SAMPLE_MIN = 120;

const TERM_KEYS: [keyof Weights, keyof TermValues][] = [
  ["wTime", "time"],
  ["wHeading", "heading"],
  ["wTour", "tour"],
  ["wCluster", "cluster"],
];

export function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

/** Exponential moving average step. */
export function ema(previous: number, sample: number, alpha = EMA_ALPHA): number {
  return previous + alpha * (sample - previous);
}

/**
 * Observed speed relative to the ORS foot speed, from the route between two hints.
 * @returns null when the sample is not meaningful
 */
export function speedSample(routeDistanceM: number, gapMinutes: number, dwellMinutes: number): number | null {
  const moving = gapMinutes - dwellMinutes;
  if (gapMinutes > MAX_SPEED_SAMPLE_GAP_MIN || moving < MIN_MOVING_MINUTES || routeDistanceM < MIN_SPEED_SAMPLE_DISTANCE_M) return null;
  return routeDistanceM / moving / WALK_M_PER_MIN;
}

export function updateSpeedFactor(current: number, sample: number): number {
  return clamp(ema(current, sample), SPEED_FACTOR_RANGE);
}

/**
 * Time spent at a group: from the visit until the first observation outside the radius,
 * minus the time needed to walk to that observation.
 */
export function dwellSample(visitedAt: Date, leftAt: Date, travelMinutes: number): number | null {
  const total = (leftAt.getTime() - visitedAt.getTime()) / 60_000;
  if (total < 0 || total > MAX_DWELL_SAMPLE_MIN) return null;
  return Math.max(0, total - travelMinutes);
}

export function updateDwell(current: number, sample: number): number {
  return clamp(ema(current, sample), DWELL_RANGE);
}

/**
 * One gradient-ascent step on the log-likelihood of the actual group:
 * w ← w + 0.1 · (term(actual) − Σ p_i · term(candidate_i)), then clamp to 0–2.
 */
export function updateWeights(weights: Weights, snapshot: SnapshotCandidate[], actualTeamApiId: number): Weights {
  const actual = snapshot.find((candidate) => candidate.teamApiId === actualTeamApiId);
  if (!actual) return weights;
  const next = { ...weights };
  for (const [weightKey, termKey] of TERM_KEYS) {
    const expected = snapshot.reduce((sum, candidate) => sum + candidate.probability * candidate.terms[termKey], 0);
    next[weightKey] = clamp(weights[weightKey] + WEIGHT_STEP * (actual.terms[termKey] - expected), WEIGHT_RANGE);
  }
  return next;
}

/** Count a top-1 / top-3 hit for the actual group. */
export function evaluateSnapshot(accuracy: Accuracy, snapshot: SnapshotCandidate[], actualTeamApiId: number): Accuracy {
  const ranked = [...snapshot].sort((a, b) => b.probability - a.probability);
  const rank = ranked.findIndex((candidate) => candidate.teamApiId === actualTeamApiId);
  return {
    top1Hits: accuracy.top1Hits + (rank === 0 ? 1 : 0),
    top3Hits: accuracy.top3Hits + (rank >= 0 && rank < TOP_CANDIDATES ? 1 : 0),
    evaluations: accuracy.evaluations + 1,
  };
}
