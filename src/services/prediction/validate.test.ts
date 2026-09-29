import { describe, expect, test } from "bun:test";
import type { AreaFacts } from "./facts";
import { InvalidPredictionError, validatePrediction } from "./validate";

const facts: AreaFacts = {
  area: "alpha",
  status: "green",
  round: 1,
  now: new Date("2026-10-17T12:00:00Z"),
  estimate: false,
  groups: [1, 2, 3, 4].map((id) => ({ teamApiId: id, name: `G${id}`, lng: 5.48 + id * 0.01, lat: 52.08, walkMinutes: id * 10 })),
  trail: [{ id: "m", time: new Date("2026-10-17T11:00:00Z"), kind: "hint", lng: 5.48, lat: 52.08 }],
  previousVisited: [],
  manualVisits: [
    { teamApiId: 4, state: "visited" },
    { teamApiId: 3, state: "not_visited" },
  ],
};
const good = {
  round: 1,
  visitedTeamApiIds: [3, 99],
  pin: { lat: 52.085, lng: 5.49 },
  confidence: "high",
  reason: "  Loopt oost langs de dijk.  ",
};

describe("validatePrediction", () => {
  test("manual visits win, unknown ids dropped", () => {
    const result = validatePrediction(good, facts);
    expect(result.visitedTeamApiIds).toEqual([4]);
    expect(result.why).toBe("Loopt oost langs de dijk.");
    expect(result.confidence).toBe("high");
  });

  test("why cut at 120 characters, unknown confidence becomes low", () => {
    const raw = { ...good, confidence: "sure", reason: "x".repeat(300) };
    const result = validatePrediction(raw, facts);
    expect(result.why).toHaveLength(120);
    expect(result.confidence).toBe("low");
  });

  test("round is the current one, or the next when covered", () => {
    const covered = { ...facts, previousVisited: [1, 2, 3] };
    expect(validatePrediction({ ...good, round: 2 }, covered).round).toBe(2);
    expect(validatePrediction({ ...good, round: 5 }, covered).round).toBe(1);
    expect(validatePrediction({ ...good, round: 0 }, covered).round).toBe(1);
    expect(validatePrediction({ ...good, round: "x" }, covered).round).toBe(1);
  });

  test("round advance refused while too few groups are covered", () => {
    expect(validatePrediction({ ...good, round: 2 }, facts).round).toBe(1);
    // 3 of 4 covered, but a manual not_visited takes one away again
    const notVisited = { ...facts, previousVisited: [1, 2, 3], manualVisits: [{ teamApiId: 1, state: "not_visited" as const }] };
    expect(validatePrediction({ ...good, round: 2, visitedTeamApiIds: [] }, notVisited).round).toBe(1);
    expect(validatePrediction({ ...good, round: 2 }, { ...facts, groups: [], previousVisited: [] }).round).toBe(1);
  });

  test("rejects a pin more than 15 km away or missing", () => {
    expect(() => validatePrediction({ ...good, pin: { lat: 53, lng: 5.48 } }, facts)).toThrow(InvalidPredictionError);
    expect(() => validatePrediction({ ...good, pin: null }, facts)).toThrow(InvalidPredictionError);
  });

  test("rejects non-objects", () => {
    expect(() => validatePrediction("nope", facts)).toThrow(InvalidPredictionError);
  });

  test("old-round manual visits ignored when Gemini advances the round", () => {
    const oldRoundManualVisits = { ...facts, previousVisited: [2, 3, 4], manualVisits: [{ teamApiId: 1, state: "visited" as const }] };
    const raw = { ...good, round: 2, visitedTeamApiIds: [] };
    const result = validatePrediction(raw, oldRoundManualVisits);
    expect(result.round).toBe(2);
    expect(result.visitedTeamApiIds).toEqual([]);
  });
});
