import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { PredictionModel } from "../../models/prediction-model.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { moveM } from "./geo";
import { coordKey, createPredictionService, listPredictions, type PredictionDeps } from "./prediction.service";
import { RoutingUnavailableError, TransitUnavailableError, type TransitItinerary, type TransitPlanner, type WalkingRouter } from "./routing";
import { straightLineRouter } from "./straight-line.router";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const noTransit: TransitPlanner = {
  plan: async () => {
    throw new Error("transit planner should not be called");
  },
};
const down = async (): Promise<never> => {
  throw new RoutingUnavailableError("ORS down");
};
const failingRouter: WalkingRouter = { matrix: down, route: down, isochrones: down };

function serviceAt(minutes: number, overrides: Partial<PredictionDeps> = {}) {
  return createPredictionService({ walking: straightLineRouter, fallback: straightLineRouter, transit: noTransit, now: () => at(minutes), ...overrides });
}

/** Three alpha groups: 1 km east, 3 km east, 2.5 km west of O. */
async function alphaWithThreeGroups() {
  await setAreaStatus("Alpha", "green");
  await makeTeam(1, "alpha", moveM(O, 1000, 0));
  await makeTeam(2, "alpha", moveM(O, 3000, 0));
  await makeTeam(3, "alpha", moveM(O, -2500, 0));
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("status handling", () => {
  test("red pauses the prediction", async () => {
    await setAreaStatus("Alpha", "red");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    await addObservation("alpha", at(0), O);
    const prediction = await serviceAt(10).recomputeArea("alpha");
    expect(prediction).toMatchObject({ paused: true, reason: "Inactief, voorspelling gepauzeerd", candidates: [], zone: { core: null, outer: null, islands: [] } });
  });

  test("no observations yet", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    const prediction = await serviceAt(10).recomputeArea("alpha");
    expect(prediction).toMatchObject({ paused: false, reason: "Nog geen waarnemingen", lastObservation: null, candidates: [] });
  });

  test("no groups", async () => {
    await setAreaStatus("Bravo", "green");
    await addObservation("bravo", at(0), O);
    expect((await serviceAt(10).recomputeArea("bravo")).reason).toBe("Geen groepen gekoppeld");
  });
});

describe("walking prediction", () => {
  test("ranks the nearest group ahead first, with ETA and zones", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0), MarkerType.Spot);
    await addObservation("alpha", at(60), O);
    const prediction = await serviceAt(80).recomputeArea("alpha");

    expect(prediction.mode).toBe("walking");
    expect(prediction.estimate).toBe(false);
    expect(prediction.lastObservation).toMatchObject({ time: at(60), kind: "hint" });
    expect(prediction.candidates.map((candidate) => candidate.teamApiId)).toEqual([1, 2, 3]);
    const [first] = prediction.candidates;
    expect(first.travelMinutes).toBe(16);
    expect(first.via).toBe("walk");
    expect(first.overdue).toBe(false);
    expect((first.eta.getTime() - at(60).getTime()) / 60_000).toBeCloseTo(15 + 15.6, 1);
    expect(prediction.candidates.reduce((sum, candidate) => sum + candidate.probability, 0)).toBeCloseTo(1, 6);
    expect(prediction.zone.outer?.type).toBe("Polygon");
    expect(prediction.zone.core?.type).toBe("Polygon");
    expect(prediction.zone.islands).toEqual([]);

    const stored = await listPredictions();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty("snapshot");
    expect(stored[0]).not.toHaveProperty("signature");
  });

  test("flags candidates whose ETA has passed", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(60), O);
    const prediction = await serviceAt(100).recomputeArea("alpha");
    expect(prediction.candidates.find((candidate) => candidate.teamApiId === 1)?.overdue).toBe(true);
    expect(prediction.candidates.find((candidate) => candidate.teamApiId === 2)?.overdue).toBe(false);
  });

  test("falls back to estimates when routing is unavailable", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), O);
    const prediction = await serviceAt(80, { walking: failingRouter }).recomputeArea("alpha");
    expect(prediction.estimate).toBe(true);
    expect(prediction.candidates).toHaveLength(3);
    expect(prediction.zone.outer?.type).toBe("Polygon");
  });

  test("a visited group is no candidate and is stored as an auto visit", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, 1000, 50));
    const prediction = await serviceAt(10).recomputeArea("alpha");
    expect(prediction.candidates.map((candidate) => candidate.teamApiId).sort()).toEqual([2, 3]);
    const visits = await GroupVisit.find().lean();
    expect(visits.map((visit) => [visit.teamApiId, visit.round, String(visit.source)])).toEqual([[1, 1, "auto"]]);
  });
});

describe("public transport", () => {
  function busItinerary(departAt: Date): TransitItinerary {
    const stop = (name: string, location: LngLat, arrival: Date | null) => ({ name, lng: location[0], lat: location[1], arrival, departure: null });
    return {
      startTime: plus(departAt, 5),
      endTime: plus(departAt, 40),
      legs: [
        { mode: "WALK", from: stop("START", O, null), to: stop("Halte A", moveM(O, 300, 0), plus(departAt, 5)), line: null },
        { mode: "BUS", from: stop("Halte A", moveM(O, 300, 0), null), to: stop("Halte B", moveM(O, 7800, 0), plus(departAt, 30)), line: "80" },
        { mode: "WALK", from: stop("Halte B", moveM(O, 7800, 0), null), to: stop("END", moveM(O, 8000, 0), plus(departAt, 40)), line: null },
      ],
    };
  }

  async function oscarWithOneGroup() {
    await setAreaStatus("Oscar", "green");
    await makeTeam(11, "oscar", moveM(O, 8000, 0));
    await addObservation("oscar", at(0), O, MarkerType.Spot);
  }

  test("oscar uses min(walk, transit), labels the line and adds islands", async () => {
    await oscarWithOneGroup();
    const transit: TransitPlanner = { plan: async (_from, _to, departAt) => busItinerary(departAt) };
    const prediction = await serviceAt(90, { transit }).recomputeArea("oscar");
    expect(prediction.mode).toBe("transit");
    expect(prediction.transitUnavailable).toBe(false);
    expect(prediction.candidates[0]).toMatchObject({ teamApiId: 11, via: "transit", transitLabel: "bus 80", travelMinutes: 40 });
    expect(prediction.zone.islands).toHaveLength(1);
  });

  test("Transitous down → walking only, flagged", async () => {
    await oscarWithOneGroup();
    const transit: TransitPlanner = {
      plan: async () => {
        throw new TransitUnavailableError("down");
      },
    };
    const prediction = await serviceAt(90, { transit }).recomputeArea("oscar");
    expect(prediction.transitUnavailable).toBe(true);
    expect(prediction.candidates[0].via).toBe("walk");
    expect(prediction.zone.islands).toEqual([]);
  });
});

describe("live learning", () => {
  test("a new hint updates the speed and evaluates the previous prediction at the next visit", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    await makeTeam(2, "alpha", moveM(O, 3000, 0));
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    const first = await serviceAt(5).recomputeArea("alpha");
    expect(first.candidates[0].teamApiId).toBe(1);

    await addObservation("alpha", at(60), moveM(O, 1000, 0));
    await serviceAt(65).recomputeArea("alpha");

    const model = await PredictionModel.findOne({ area: "alpha" }).lean();
    // 2 km straight × 1.3 = 2600 m in 60 − 15 = 45 min → 0.6933; EMA from 1.0 → 0.908
    expect(model?.speedFactor).toBeCloseTo(0.908, 3);
    expect(model?.accuracy).toEqual({ top1Hits: 1, top3Hits: 1, evaluations: 1 });
    expect(model?.pendingSnapshot).toBeNull();
    expect(model?.weights?.wTime).not.toBe(1);
  });
});

describe("recomputeDue", () => {
  test("skips fresh areas and isolates failures", async () => {
    await setAreaStatus("Alpha", "green");
    await setAreaStatus("Bravo", "green");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    await makeTeam(2, "bravo", moveM(O, 0, 5000));
    await addObservation("alpha", at(0), O);
    await addObservation("bravo", at(0), moveM(O, 0, 4000));

    let clock = at(5);
    const deps: PredictionDeps = { walking: straightLineRouter, fallback: straightLineRouter, transit: noTransit, now: () => clock };
    expect(await createPredictionService(deps).recomputeDue()).toEqual({ recomputed: ["alpha", "bravo"], failed: [] });
    clock = at(7);
    expect((await createPredictionService(deps).recomputeDue()).recomputed).toEqual([]);

    const bravoPosition = moveM(O, 0, 4500);
    await addObservation("alpha", at(6), moveM(O, 100, 0), MarkerType.Spot);
    await addObservation("bravo", at(6), bravoPosition, MarkerType.Spot);
    const broken: WalkingRouter = {
      ...straightLineRouter,
      matrix: async (sources, destinations) => {
        if (coordKey(sources[0]) === coordKey(bravoPosition)) throw new Error("boom");
        return straightLineRouter.matrix(sources, destinations);
      },
    };
    const result = await createPredictionService({ ...deps, walking: broken }).recomputeDue();
    expect(result.recomputed).toEqual(["alpha"]);
    expect(result.failed.map((failure) => failure.area)).toEqual(["bravo"]);
    expect((await Prediction.findOne({ area: "bravo" }).lean())?.updatedAt).toEqual(at(5));

    clock = at(13);
    expect((await createPredictionService({ ...deps, walking: broken }).recomputeDue()).failed.map((failure) => failure.area)).toEqual(["bravo"]);
  });
});
