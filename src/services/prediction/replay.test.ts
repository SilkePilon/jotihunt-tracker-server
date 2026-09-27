import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GroupVisit, VisitState } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { PredictionModel } from "../../models/prediction-model.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { DETOUR_FACTOR, VISIT_RADIUS_M, WEIGHT_RANGE } from "./constants";
import { distanceM, moveM, pointToLine } from "./geo";
import { createPredictionService, type PredictionDto } from "./prediction.service";
import type { TransitPlanner } from "./routing";
import { straightLineRouter, straightLineSeconds } from "./straight-line.router";
import { planTour } from "./tour";
import type { LngLat } from "./types";

/*
 * Replay acceptance test (spec "Testing"): a synthetic area with 12 scattered groups and a scripted fox
 * that walks a planned tour at 4 km/h with a 15-minute stop per group. Hints are realistic: position
 * at the full hour ± 100 m, time floored to the hour, entered 15 minutes late. One spot between hints
 * and one red hour. The predictor only ever sees the observations; routing is the straight-line router.
 */

const SEEDS = [1, 2, 3];
const GROUP_COUNT = 12;
/** Box the groups are scattered in, relative to the start (metres east / north). */
const BOX = { east: [0, 12_000], north: [-6_000, 6_000] } as const;
/** Groups are at least this far apart (and from the start), so visits are unambiguous. */
const MIN_SPACING_M = 1_200;
/** The fox's own walk never passes this close to a group it still has to visit (else it would visit it early). */
const PASS_BY_CLEARANCE_M = 2 * VISIT_RADIUS_M;
const HINT_NOISE_M = 100;
const HINT_DELAY_MIN = 15;
const DWELL_MIN = 15;
/** Straight-line progress of a fox walking 4 km/h over a 1.3× detour. */
const FOX_M_PER_MIN = 4000 / 60 / DETOUR_FACTOR;
/** Hour (after the start) whose status is red: no hint, prediction must pause. */
const RED_HOUR = 6;
/** Minute (after the start) of the one spot between hints. */
const SPOT_MINUTE = 4 * 60 + 30;
const START: LngLat = [5.3, 52.05];
const T0 = Date.UTC(2026, 9, 17, 9, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: () => number, [min, max]: readonly [number, number]) => min + random() * (max - min);

interface Group {
  teamApiId: number;
  location: LngLat;
}

interface Leg {
  from: LngLat;
  to: LngLat;
  start: number;
  end: number;
}

interface Scenario {
  /** Groups in the fox's visiting order */
  order: Group[];
  /** Arrival minute per entry of `order` */
  arrivals: number[];
  legs: Leg[];
}

/** Scatter the groups and plan the fox's tour: the shortest tour, with one deliberately non-greedy swap. */
function buildScenario(random: () => number): Scenario {
  for (;;) {
    const groups: Group[] = [];
    while (groups.length < GROUP_COUNT) {
      const location = moveM(START, between(random, BOX.east), between(random, BOX.north));
      const spaced = distanceM(location, START) >= MIN_SPACING_M && groups.every((group) => distanceM(group.location, location) >= MIN_SPACING_M);
      if (spaced) groups.push({ teamApiId: 100 + groups.length, location });
    }
    const tour = planTour(
      groups.map((group) => straightLineSeconds(START, group.location)),
      groups.map((a) => groups.map((b) => straightLineSeconds(a.location, b.location))),
    );
    // The non-greedy step: somewhere in the middle, the fox visits the next two stops the other way round.
    const swapAt = 3 + Math.floor(random() * 5);
    [tour[swapAt], tour[swapAt + 1]] = [tour[swapAt + 1], tour[swapAt]];
    const order = tour.map((index) => groups[index]);

    const stops = [START, ...order.map((group) => group.location)];
    // Groups still ahead in the tour must not lie on a leg (earlier ones are already visited this round).
    const passesOthers = order.some((target, leg) =>
      order.slice(leg + 1).some((ahead) => pointToLine(ahead.location, [stops[leg], target.location]).distanceM < PASS_BY_CLEARANCE_M),
    );
    if (passesOthers) continue;

    const legs: Leg[] = [];
    const arrivals: number[] = [];
    let clock = 0;
    let position = START;
    for (const group of order) {
      const walk = distanceM(position, group.location) / FOX_M_PER_MIN;
      legs.push({ from: position, to: group.location, start: clock, end: clock + walk });
      clock += walk;
      arrivals.push(clock);
      legs.push({ from: group.location, to: group.location, start: clock, end: clock + DWELL_MIN });
      clock += DWELL_MIN;
      position = group.location;
    }
    return { order, arrivals, legs };
  }
}

function foxAt(legs: Leg[], minutes: number): LngLat {
  const leg = legs.find((candidate) => minutes >= candidate.start && minutes <= candidate.end) ?? legs[legs.length - 1];
  const fraction = leg.end > leg.start ? Math.min(1, (minutes - leg.start) / (leg.end - leg.start)) : 1;
  return [leg.from[0] + (leg.to[0] - leg.from[0]) * fraction, leg.from[1] + (leg.to[1] - leg.from[1]) * fraction];
}

const noTransit: TransitPlanner = {
  plan: async () => {
    throw new Error("alpha is not in public-transport mode");
  },
};

async function modelState() {
  const doc = await PredictionModel.findOne({ area: "alpha" }).lean();
  if (!doc) throw new Error("no model");
  const { speedFactor, dwellMinutes, weights, accuracy, lastHintTime, lastDwellVisitAt, pendingSnapshot } = doc;
  return JSON.parse(JSON.stringify({ speedFactor, dwellMinutes, weights, accuracy, lastHintTime, lastDwellVisitAt, pendingSnapshot }));
}

interface SeedResult {
  seed: number;
  evaluated: number;
  top1: number;
  top3: number;
  baseline: number;
  top1ProbabilitySum: number;
}

async function replaySeed(seed: number): Promise<SeedResult> {
  await clearTestDb();
  const random = mulberry32(seed);
  const { order, arrivals, legs } = buildScenario(random);
  await setAreaStatus("Alpha", "green");
  for (const group of order) await makeTeam(group.teamApiId, "alpha", group.location);

  let clock = at(0);
  const service = createPredictionService({ walking: straightLineRouter, fallback: straightLineRouter, transit: noTransit, now: () => clock });
  const result: SeedResult = { seed, evaluated: 0, top1: 0, top3: 0, baseline: 0, top1ProbabilitySum: 0 };

  // Independent bookkeeping of the spec's learning rule: when a new hint arrives, the previous prediction
  // (if it had candidates) is evaluated once at the first detected visit after the observation it was based on.
  let previous: PredictionDto | null = null;
  let pendingSince: Date | null = null;
  let expectedEvaluations = 0;

  async function recompute(newHint: boolean): Promise<PredictionDto> {
    const prediction = await service.recomputeArea("alpha");
    if (newHint && pendingSince === null && previous && previous.candidates.length > 0 && previous.lastObservation) {
      pendingSince = new Date(previous.lastObservation.time);
    }
    if (pendingSince !== null) {
      const since = pendingSince.getTime();
      const visits = await GroupVisit.find({ area: "alpha", state: VisitState.Visited }).lean();
      if (visits.some((visit) => visit.visitedAt && visit.visitedAt.getTime() > since)) {
        expectedEvaluations++;
        pendingSince = null;
      }
    }
    previous = prediction;
    return prediction;
  }

  let hints = 0;
  let spotDone = false;
  for (let hour = 0; hour * 60 <= arrivals[arrivals.length - 1]; hour++) {
    const minutes = hour * 60;

    if (!spotDone && SPOT_MINUTE < minutes) {
      clock = at(SPOT_MINUTE);
      await addObservation("alpha", clock, foxAt(legs, SPOT_MINUTE), MarkerType.Spot);
      await recompute(false);
      spotDone = true;
    }

    clock = at(minutes + HINT_DELAY_MIN);
    if (hour === RED_HOUR) {
      await setAreaStatus("Alpha", "red");
      const paused = await recompute(false);
      expect(paused.paused).toBe(true);
      expect(paused.candidates).toEqual([]);
      await setAreaStatus("Alpha", "green");
      continue;
    }

    const truth = foxAt(legs, minutes);
    const hint = moveM(truth, (random() * 2 - 1) * HINT_NOISE_M, (random() * 2 - 1) * HINT_NOISE_M);
    await addObservation("alpha", at(minutes), hint);
    hints++;
    const prediction = await recompute(true);

    // Same hint again: the learned model must not change (no double counting).
    const before = await modelState();
    await recompute(false);
    expect(await modelState()).toEqual(before);

    if (hints < 3) continue;
    // The true next group: the first one in the fox's order it has not reached (or come within the visit radius of) yet.
    const nextIndex = order.findIndex((group, index) => arrivals[index] > minutes && distanceM(hint, group.location) > VISIT_RADIUS_M);
    if (nextIndex === -1 || order.length - nextIndex <= 3) continue;
    const next = order[nextIndex].teamApiId;

    const visited = new Set(
      (await GroupVisit.find({ area: "alpha", round: prediction.round, state: VisitState.Visited }).lean()).map((visit) => visit.teamApiId),
    );
    const nearest3 = order
      .filter((group) => !visited.has(group.teamApiId))
      .sort((a, b) => distanceM(hint, a.location) - distanceM(hint, b.location))
      .slice(0, 3)
      .map((group) => group.teamApiId);

    result.evaluated++;
    result.top1ProbabilitySum += prediction.candidates[0]?.probability ?? 0;
    if (prediction.candidates[0]?.teamApiId === next) result.top1++;
    if (prediction.candidates.some((candidate) => candidate.teamApiId === next)) result.top3++;
    if (nearest3.includes(next)) result.baseline++;
  }

  const model = await PredictionModel.findOne({ area: "alpha" }).lean();
  expect(model?.accuracy?.evaluations).toBe(expectedEvaluations);
  expect(expectedEvaluations).toBeGreaterThan(0);
  expect(model?.speedFactor).toBeLessThan(1);
  for (const weight of Object.values(model?.weights ?? {})) {
    if (typeof weight !== "number") continue;
    expect(weight).toBeGreaterThanOrEqual(WEIGHT_RANGE[0]);
    expect(weight).toBeLessThanOrEqual(WEIGHT_RANGE[1]);
  }
  console.log(
    `replay seed ${seed}: evaluated ${result.evaluated}, top-1 ${result.top1}/${result.evaluated}, top-3 ${result.top3}/${result.evaluated}, ` +
      `3-nearest baseline ${result.baseline}/${result.evaluated}, mean top-1 p ${(result.top1ProbabilitySum / Math.max(1, result.evaluated)).toFixed(3)}, ` +
      `speedFactor ${model?.speedFactor?.toFixed(3)}, dwell ${model?.dwellMinutes?.toFixed(1)}, evaluations ${model?.accuracy?.evaluations}, ` +
      `weights ${JSON.stringify(model?.weights)}`,
  );
  return result;
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

describe("replay", () => {
  test(
    "over 3 seeds the predictor beats the 3-nearest baseline: top-3 ≥ 70 %, top-1 ≥ 40 %, calibrated",
    async () => {
      const results: SeedResult[] = [];
      for (const seed of SEEDS) results.push(await replaySeed(seed));
      const total = results.reduce(
        (sum, seed) => ({
          evaluated: sum.evaluated + seed.evaluated,
          top1: sum.top1 + seed.top1,
          top3: sum.top3 + seed.top3,
          baseline: sum.baseline + seed.baseline,
          top1ProbabilitySum: sum.top1ProbabilitySum + seed.top1ProbabilitySum,
        }),
        { evaluated: 0, top1: 0, top3: 0, baseline: 0, top1ProbabilitySum: 0 },
      );
      const top1Rate = total.top1 / total.evaluated;
      const meanTop1Probability = total.top1ProbabilitySum / total.evaluated;
      console.log(
        `replay total: evaluated ${total.evaluated}, top-1 ${total.top1} (${top1Rate.toFixed(3)}), top-3 ${total.top3} (${(total.top3 / total.evaluated).toFixed(3)}), ` +
          `baseline ${total.baseline} (${(total.baseline / total.evaluated).toFixed(3)}), mean top-1 p ${meanTop1Probability.toFixed(3)}`,
      );

      expect(total.evaluated).toBeGreaterThanOrEqual(8);
      expect(total.top3 / total.evaluated).toBeGreaterThanOrEqual(0.7);
      expect(top1Rate).toBeGreaterThanOrEqual(0.4);
      expect(total.top3).toBeGreaterThanOrEqual(total.baseline);
      expect(meanTop1Probability).toBeLessThanOrEqual(top1Rate + 0.25);
    },
    120_000,
  );
});
