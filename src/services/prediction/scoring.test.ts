import { describe, expect, test } from "bun:test";
import { moveM } from "./geo";
import { computeHeading, computeTerms, scoreCandidates, softmax, type ScoringCandidate, type ScoringInput } from "./scoring";
import { DEFAULT_PARAMS, type LngLat, type Observation } from "./types";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function candidate(teamApiId: number, location: LngLat, travelMinutes = 10): ScoringCandidate {
  return { teamApiId, location, travelMinutes };
}

function input(candidates: ScoringCandidate[], overrides: Partial<ScoringInput> = {}): ScoringInput {
  return { position: O, heading: null, candidates, tourFirstIndex: null, weights: DEFAULT_PARAMS.weights, ...overrides };
}

describe("computeHeading", () => {
  const obs = (minutes: number, location: LngLat): Observation => ({ time: at(minutes), lng: location[0], lat: location[1], kind: "hint" });

  test("bearing between the last two observations", () => {
    expect(computeHeading([obs(0, O), obs(60, moveM(O, 1000, 0))])).toBeCloseTo(90, 0);
  });

  test("none when too close, too far apart in time, or only one observation", () => {
    expect(computeHeading([obs(0, O), obs(60, moveM(O, 100, 0))])).toBeNull();
    expect(computeHeading([obs(0, O), obs(240, moveM(O, 1000, 0))])).toBeNull();
    expect(computeHeading([obs(0, O)])).toBeNull();
  });
});

describe("computeTerms", () => {
  test("time term is relative to the slowest candidate", () => {
    const terms = computeTerms(input([candidate(1, moveM(O, 1000, 0), 10), candidate(2, moveM(O, 5000, 0), 20), candidate(3, moveM(O, 9000, 0), 40)]));
    expect(terms.map((t) => t.time)).toEqual([0.75, 0.5, 0]);
  });

  test("heading term is the clamped cosine", () => {
    const terms = computeTerms(
      input([candidate(1, moveM(O, 2000, 0)), candidate(2, moveM(O, 0, 2000)), candidate(3, moveM(O, -2000, 0))], { heading: 90 }),
    );
    expect(terms[0].heading).toBeCloseTo(1, 3);
    expect(terms[1].heading).toBeCloseTo(0, 2);
    expect(terms[2].heading).toBe(0);
  });

  test("heading term is 0 without a heading", () => {
    expect(computeTerms(input([candidate(1, moveM(O, 2000, 0))]))[0].heading).toBe(0);
  });

  test("tour term marks the first stop of the tour", () => {
    const terms = computeTerms(input([candidate(1, O), candidate(2, O), candidate(3, O)], { tourFirstIndex: 1 }));
    expect(terms.map((t) => t.tour)).toEqual([0, 1, 0]);
  });

  test("cluster term counts other candidates within 1.5 km", () => {
    const terms = computeTerms(input([candidate(1, moveM(O, 5000, 0)), candidate(2, moveM(O, 5800, 0)), candidate(3, moveM(O, -5000, 0))]));
    expect(terms.map((t) => t.cluster)).toEqual([1 / 3, 1 / 3, 0]);
  });
});

describe("softmax", () => {
  test("equal scores share the probability", () => {
    expect(softmax([0, 0])).toEqual([0.5, 0.5]);
  });

  test("uses temperature 0.15", () => {
    const [p] = softmax([1, 0.85]);
    expect(p).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
  });

  test("is numerically stable", () => {
    const result = softmax([1000, 999]);
    expect(result.every(Number.isFinite)).toBe(true);
    expect(result[0] + result[1]).toBeCloseTo(1, 9);
  });
});

describe("scoreCandidates", () => {
  test("keeps input order and probabilities sum to 1", () => {
    const scored = scoreCandidates(
      input([candidate(1, moveM(O, 1000, 0), 15), candidate(2, moveM(O, 3000, 0), 45)], { heading: 90, tourFirstIndex: 0 }),
    );
    expect(scored.map((s) => s.teamApiId)).toEqual([1, 2]);
    expect(scored[0].probability).toBeGreaterThan(scored[1].probability);
    expect(scored[0].probability + scored[1].probability).toBeCloseTo(1, 9);
    expect(scored[0].score).toBeCloseTo(1 * (1 - 15 / 45) + 0.5 * 1 + 0.7 * 1 + 0.3 * 0, 3);
  });
});
