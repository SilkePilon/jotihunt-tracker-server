import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { PredictionModel } from "../../models/prediction-model.model";
import { RoutingCache } from "../../models/routing-cache.model";
import { Team } from "../../models/team.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { moveM } from "./geo";
import { coordKey, createPredictionService, listPredictions, type PredictionDeps } from "./prediction.service";
import { setManualVisit } from "./visit.service";
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

describe("ORS circuit breaker", () => {
  function countingFailingRouter() {
    let calls = 0;
    const fail = async (): Promise<never> => {
      calls++;
      throw new RoutingUnavailableError("ORS down");
    };
    const router: WalkingRouter = { matrix: fail, route: fail, isochrones: fail };
    return { router, calls: () => calls };
  }

  test("after the first outage, later calls in the same run skip ORS", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), O);
    const { router, calls } = countingFailingRouter();
    const prediction = await serviceAt(80, { walking: router }).recomputeArea("alpha");
    expect(prediction.estimate).toBe(true);
    expect(calls()).toBe(1);
  });

  test("ORS is retried after the cooldown", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), O);
    const { router, calls } = countingFailingRouter();
    let clock = at(80);
    const service = createPredictionService({ walking: router, fallback: straightLineRouter, transit: noTransit, now: () => clock });

    const first = await service.recomputeArea("alpha");
    expect(first.estimate).toBe(true);
    expect(calls()).toBe(1);

    // Still within the 5-minute cooldown: ORS must not be touched again.
    clock = plus(at(80), 3);
    await service.recomputeArea("alpha");
    expect(calls()).toBe(1);

    // Past the cooldown: the next call is a half-open probe against ORS.
    clock = plus(at(80), 6);
    await service.recomputeArea("alpha");
    expect(calls()).toBe(2);
  });

  test("success after the half-open probe resumes normal ORS use", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), O);
    const { router: failing, calls } = countingFailingRouter();
    let useFailing = true;
    const router: WalkingRouter = {
      matrix: (...args) => (useFailing ? failing.matrix(...args) : straightLineRouter.matrix(...args)),
      route: (...args) => (useFailing ? failing.route(...args) : straightLineRouter.route(...args)),
      isochrones: (...args) => (useFailing ? failing.isochrones(...args) : straightLineRouter.isochrones(...args)),
    };
    let clock = at(80);
    const service = createPredictionService({ walking: router, fallback: straightLineRouter, transit: noTransit, now: () => clock });

    const first = await service.recomputeArea("alpha");
    expect(first.estimate).toBe(true);
    expect(calls()).toBe(1);

    useFailing = false;
    clock = plus(at(80), 6);
    const second = await service.recomputeArea("alpha");
    expect(second.estimate).toBe(false);
    expect(calls()).toBe(1);
  });
});

describe("ORS error classes", () => {
  const LAKE = moveM(O, -1000, 0);

  /** straight-line routing, but every request touching the LAKE point fails with the given kind. */
  function routerFailingAt(point: LngLat, kind: "request" | "permanent") {
    let failures = 0;
    let calls = 0;
    const touches = (coords: LngLat[]) => coords.some((coord) => coordKey(coord) === coordKey(point));
    const guard = <T>(coords: LngLat[], run: () => Promise<T>) => {
      calls++;
      if (kind === "permanent" || touches(coords)) {
        failures++;
        return Promise.reject(new RoutingUnavailableError("ORS directions: Request failed with status code 404", { kind }));
      }
      return run();
    };
    const router: WalkingRouter = {
      matrix: (sources, destinations) => guard([...sources, ...destinations], () => straightLineRouter.matrix(sources, destinations)),
      route: (a, b) => guard([a, b], () => straightLineRouter.route(a, b)),
      isochrones: (center, ranges) => guard([center], () => straightLineRouter.isochrones(center, ranges)),
    };
    return { router, failures: () => failures, calls: () => calls };
  }

  test("one unroutable point does not put other areas in estimate mode and is not re-probed", async () => {
    await alphaWithThreeGroups();
    await setAreaStatus("Bravo", "green");
    await makeTeam(21, "bravo", moveM(O, 0, 6000));
    await addObservation("alpha", at(0), LAKE);
    await addObservation("alpha", at(60), O);
    await addObservation("bravo", at(60), moveM(O, 0, 4000));
    const { router, failures } = routerFailingAt(LAKE, "request");
    let clock = at(80);
    const service = createPredictionService({ walking: router, fallback: straightLineRouter, transit: noTransit, now: () => clock });

    const alpha = await service.recomputeArea("alpha");
    expect(alpha.estimate).toBe(true);
    expect(failures()).toBe(1);

    const bravo = await service.recomputeArea("bravo");
    expect(bravo.estimate).toBe(false);

    // The fallback for the bad pair is cached for 6 h: the next recompute does not ask ORS again.
    clock = plus(at(80), 10);
    const again = await service.recomputeArea("alpha");
    expect(failures()).toBe(1);
    expect(again.estimate).toBe(true);
    const cached = await RoutingCache.findOne({ key: `route:${coordKey(LAKE)}>${coordKey(O)}` }).lean();
    expect(cached?.estimate).toBe(true);
    const ttlH = ((cached?.expiresAt.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(ttlH).toBeGreaterThan(5.9);
    expect(ttlH).toBeLessThanOrEqual(6);
  });

  test("a permanent error (401/403) stops ORS calls for good, not for a cooldown", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), O);
    const { router, calls } = routerFailingAt(O, "permanent");
    let clock = at(80);
    const service = createPredictionService({ walking: router, fallback: straightLineRouter, transit: noTransit, now: () => clock });
    expect((await service.recomputeArea("alpha")).estimate).toBe(true);
    expect(calls()).toBe(1);
    clock = plus(at(80), 120);
    expect((await service.recomputeArea("alpha")).estimate).toBe(true);
    expect(calls()).toBe(1);
  });
});

describe("routing cache keys", () => {
  function countingRouter() {
    const counts = { matrix: 0 };
    const router: WalkingRouter = {
      ...straightLineRouter,
      matrix: (sources, destinations) => {
        counts.matrix++;
        return straightLineRouter.matrix(sources, destinations);
      },
    };
    return { router, counts };
  }

  test("moving a group invalidates the cached matrices", async () => {
    await alphaWithThreeGroups();
    await addObservation("alpha", at(60), O);
    const { router, counts } = countingRouter();
    const service = serviceAt(80, { walking: router });
    await service.recomputeArea("alpha");
    expect(counts.matrix).toBe(2);
    await service.recomputeArea("alpha");
    expect(counts.matrix).toBe(2);

    await Team.updateOne({ apiId: 2 }, { $set: { "location.coordinates": moveM(O, 2000, 500) } });
    await service.recomputeArea("alpha");
    expect(counts.matrix).toBe(4);
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

describe("Transitous breaker", () => {
  async function oscar() {
    await setAreaStatus("Oscar", "green");
    await makeTeam(11, "oscar", moveM(O, 8000, 0));
    await addObservation("oscar", at(0), O, MarkerType.Spot);
  }

  test("after a failure Transitous is skipped for 5 minutes (walking only, flagged)", async () => {
    await oscar();
    let calls = 0;
    const transit: TransitPlanner = {
      plan: async () => {
        calls++;
        throw new TransitUnavailableError("timeout of 20000ms exceeded");
      },
    };
    let clock = at(90);
    const service = createPredictionService({ walking: straightLineRouter, fallback: straightLineRouter, transit, now: () => clock });

    expect((await service.recomputeArea("oscar")).transitUnavailable).toBe(true);
    expect(calls).toBe(1);

    clock = plus(at(90), 3);
    const skipped = await service.recomputeArea("oscar");
    expect(calls).toBe(1);
    expect(skipped.transitUnavailable).toBe(true);
    expect(skipped.candidates[0].via).toBe("walk");

    clock = plus(at(90), 6);
    await service.recomputeArea("oscar");
    expect(calls).toBe(2);
  });

  test("a moved group gets a fresh transit plan (coordinates in the cache key)", async () => {
    await oscar();
    let calls = 0;
    const transit: TransitPlanner = {
      plan: async () => {
        calls++;
        return null;
      },
    };
    const service = serviceAt(90, { transit });
    await service.recomputeArea("oscar");
    await service.recomputeArea("oscar");
    expect(calls).toBe(1);
    await Team.updateOne({ apiId: 11 }, { $set: { "location.coordinates": moveM(O, 8000, 800) } });
    await service.recomputeArea("oscar");
    expect(calls).toBe(2);
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

describe("dwell learning", () => {
  /** Group 1 lies on the straight route between the two hints: a `route` visit interpolated at t = 30. */
  async function passByRoute() {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    await makeTeam(2, "alpha", moveM(O, 1000, 6000));
    await addObservation("alpha", at(0), moveM(O, -1000, 0));
    await addObservation("alpha", at(60), moveM(O, 3000, 0));
  }

  test("an interpolated route visit is no dwell sample", async () => {
    await passByRoute();
    await serviceAt(65).recomputeArea("alpha");
    expect((await GroupVisit.findOne({ teamApiId: 1 }).lean())?.evidence).toBe("route");
    const model = await PredictionModel.findOne({ area: "alpha" }).lean();
    expect(model?.dwellMinutes).toBe(15);
    expect(model?.lastDwellVisitAt ?? null).toBeNull();
  });

  test("a manual visit is a dwell sample", async () => {
    await passByRoute();
    await setManualVisit(1, "visited", at(30));
    await serviceAt(65).recomputeArea("alpha");
    const model = await PredictionModel.findOne({ area: "alpha" }).lean();
    expect(model?.dwellMinutes).not.toBe(15);
    expect(model?.lastDwellVisitAt).toEqual(at(30));
  });

  test("a point visit is a dwell sample", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", moveM(O, 1000, 0));
    await makeTeam(2, "alpha", moveM(O, 1000, 6000));
    await addObservation("alpha", at(0), moveM(O, 1000, 50));
    await addObservation("alpha", at(40), moveM(O, 3000, 0));
    await serviceAt(45).recomputeArea("alpha");
    const model = await PredictionModel.findOne({ area: "alpha" }).lean();
    // speed 2600 m / 25 min → 1.074; travel 2000 m × 1.3 / 83.33 / 1.074 ≈ 29.0 min; sample 11.0 → EMA 13.8
    expect(model?.dwellMinutes).toBeCloseTo(13.8, 1);
    expect(model?.lastDwellVisitAt).toEqual(at(0));
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
