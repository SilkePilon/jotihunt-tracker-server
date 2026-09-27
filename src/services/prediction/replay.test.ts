import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PredictionModel } from "../../models/prediction-model.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { DETOUR_FACTOR, VISIT_RADIUS_M, WALK_M_PER_MIN } from "./constants";
import { distanceM, moveM } from "./geo";
import { createPredictionService } from "./prediction.service";
import type { TransitPlanner } from "./routing";
import { straightLineRouter } from "./straight-line.router";
import type { LngLat } from "./types";

const START: LngLat = [5.3, 52.05];
const NORTH_OFFSETS_M = [0, 120, -80, 100, -100, 60, -60, 0];
const GROUPS = NORTH_OFFSETS_M.map((northM, index) => ({ teamApiId: 100 + index, location: moveM(START, 2000 * (index + 1), northM) }));
const DWELL_MIN = 15;
/** Straight-line progress of a fox walking 5 km/h over a 1.3× detour. */
const FOX_M_PER_MIN = WALK_M_PER_MIN / DETOUR_FACTOR;
const T0 = Date.UTC(2026, 9, 17, 9, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

interface Leg {
  from: LngLat;
  to: LngLat;
  start: number;
  end: number;
}

/** The scripted route: walk to each group in order, stay 15 minutes. Times in minutes after T0. */
function buildScript(): { legs: Leg[]; arrivals: number[] } {
  const legs: Leg[] = [];
  const arrivals: number[] = [];
  let clock = 0;
  let position = START;
  for (const group of GROUPS) {
    const walk = distanceM(position, group.location) / FOX_M_PER_MIN;
    legs.push({ from: position, to: group.location, start: clock, end: clock + walk });
    clock += walk;
    arrivals.push(clock);
    legs.push({ from: group.location, to: group.location, start: clock, end: clock + DWELL_MIN });
    clock += DWELL_MIN;
    position = group.location;
  }
  return { legs, arrivals };
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

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("replay", () => {
  test("after 3 hints the top-3 contains the true next group in ≥ 70 % of the remaining hours", async () => {
    await setAreaStatus("Alpha", "green");
    for (const group of GROUPS) await makeTeam(group.teamApiId, "alpha", group.location);

    const { legs, arrivals } = buildScript();
    const approachMinutes = VISIT_RADIUS_M / FOX_M_PER_MIN;
    let clock = at(0);
    const service = createPredictionService({ walking: straightLineRouter, fallback: straightLineRouter, transit: noTransit, now: () => clock });

    let hits = 0;
    let evaluations = 0;
    for (let hour = 0; hour * 60 <= arrivals[arrivals.length - 1]; hour++) {
      const minutes = hour * 60;
      clock = at(minutes);
      await addObservation("alpha", clock, foxAt(legs, minutes));
      const prediction = await service.recomputeArea("alpha");
      if (hour < 2) continue;

      const nextIndex = arrivals.findIndex((arrival) => arrival > minutes + approachMinutes);
      if (nextIndex === -1) break;
      evaluations++;
      if (prediction.candidates.some((candidate) => candidate.teamApiId === GROUPS[nextIndex].teamApiId)) hits++;
    }

    expect(evaluations).toBeGreaterThanOrEqual(3);
    expect(hits / evaluations).toBeGreaterThanOrEqual(0.7);

    const model = await PredictionModel.findOne({ area: "alpha" }).lean();
    expect(model?.accuracy?.evaluations).toBeGreaterThanOrEqual(1);
  });
});
