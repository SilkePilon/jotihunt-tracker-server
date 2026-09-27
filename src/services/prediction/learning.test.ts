import { describe, expect, test } from "bun:test";
import { clamp, dwellSample, ema, evaluateSnapshot, speedSample, updateDwell, updateSpeedFactor, updateWeights, type SnapshotCandidate } from "./learning";

const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe("clamp and ema", () => {
  test("clamp", () => {
    expect(clamp(3, [0, 2])).toBe(2);
    expect(clamp(-1, [0, 2])).toBe(0);
    expect(clamp(1.5, [0, 2])).toBe(1.5);
  });

  test("ema with alpha 0.3", () => {
    expect(ema(1, 1.5)).toBeCloseTo(1.15, 10);
  });
});

describe("speed", () => {
  test("sample = route distance / (Δt − dwell) / ORS speed", () => {
    // 4000 m in 63 − 15 = 48 minutes = 83.33 m/min = exactly the ORS foot speed
    expect(speedSample(4000, 63, 15)).toBeCloseTo(1, 6);
  });

  test("no sample for short routes, long gaps or no moving time", () => {
    expect(speedSample(400, 60, 15)).toBeNull();
    expect(speedSample(4000, 200, 15)).toBeNull();
    expect(speedSample(4000, 18, 15)).toBeNull();
  });

  test("updateSpeedFactor applies EMA and clamps to 0.5–1.6", () => {
    expect(updateSpeedFactor(1, 0.1)).toBeCloseTo(0.73, 10);
    expect(updateSpeedFactor(1, 3)).toBe(1.6);
    expect(updateSpeedFactor(0.5, 0)).toBe(0.5);
  });
});

describe("dwell", () => {
  test("sample subtracts the travel time", () => {
    expect(dwellSample(at(0), at(40), 12)).toBe(28);
    expect(dwellSample(at(0), at(10), 30)).toBe(0);
  });

  test("no sample when leaving before the visit or more than 2 h later", () => {
    expect(dwellSample(at(10), at(0), 0)).toBeNull();
    expect(dwellSample(at(0), at(130), 0)).toBeNull();
  });

  test("updateDwell applies EMA and clamps to 0–45", () => {
    expect(updateDwell(15, 28)).toBeCloseTo(18.9, 10);
    expect(updateDwell(40, 100)).toBe(45);
    expect(updateDwell(0, 0)).toBe(0);
  });
});

describe("weights", () => {
  const snapshot: SnapshotCandidate[] = [
    { teamApiId: 1, probability: 0.7, terms: { time: 1, heading: 0, tour: 1, cluster: 0.5 } },
    { teamApiId: 2, probability: 0.3, terms: { time: 0, heading: 1, tour: 0, cluster: 0.5 } },
  ];

  test("one gradient step towards the actual group", () => {
    const next = updateWeights({ wTime: 1, wHeading: 0.5, wTour: 0.7, wCluster: 0.3 }, snapshot, 2);
    expect(next.wTime).toBeCloseTo(0.93, 10);
    expect(next.wHeading).toBeCloseTo(0.57, 10);
    expect(next.wTour).toBeCloseTo(0.63, 10);
    expect(next.wCluster).toBeCloseTo(0.3, 10);
  });

  test("clamps to 0–2", () => {
    const next = updateWeights({ wTime: 0.01, wHeading: 1.99, wTour: 0.7, wCluster: 0.3 }, snapshot, 2);
    expect(next.wTime).toBe(0);
    expect(next.wHeading).toBe(2);
  });

  test("unchanged when the actual group was not a candidate", () => {
    const weights = { wTime: 1, wHeading: 0.5, wTour: 0.7, wCluster: 0.3 };
    expect(updateWeights(weights, snapshot, 99)).toEqual(weights);
  });
});

describe("evaluateSnapshot", () => {
  const snapshot: SnapshotCandidate[] = [1, 2, 3, 4].map((teamApiId, index) => ({
    teamApiId,
    probability: 0.4 - index * 0.1,
    terms: { time: 0, heading: 0, tour: 0, cluster: 0 },
  }));
  const start = { top1Hits: 0, top3Hits: 0, evaluations: 0 };

  test("top-1 hit", () => expect(evaluateSnapshot(start, snapshot, 1)).toEqual({ top1Hits: 1, top3Hits: 1, evaluations: 1 }));
  test("top-3 hit", () => expect(evaluateSnapshot(start, snapshot, 3)).toEqual({ top1Hits: 0, top3Hits: 1, evaluations: 1 }));
  test("miss", () => expect(evaluateSnapshot(start, snapshot, 4)).toEqual({ top1Hits: 0, top3Hits: 0, evaluations: 1 }));
  test("unknown group is a miss", () => expect(evaluateSnapshot(start, snapshot, 99)).toEqual({ top1Hits: 0, top3Hits: 0, evaluations: 1 }));
});
