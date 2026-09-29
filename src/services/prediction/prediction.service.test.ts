import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { GeminiError } from "../gemini.client";
import type { FoxPredictor } from "./gemini-predictor";
import { moveM } from "./geo";
import { createPredictionService, listPredictions } from "./prediction.service";
import type { LngLat } from "./types";
import type { WalkMinutes } from "./walking";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const walk: WalkMinutes = async (_from, to) => ({ minutes: to.map((_, index) => 10 * (index + 1)), estimate: false });

function answer(overrides: Record<string, unknown> = {}) {
  return {
    round: 1,
    visitedTeamApiIds: [],
    pin: { lat: O[1], lng: O[0] + 0.005 },
    confidence: "medium",
    candidates: [
      { teamApiId: 1, probability: 0.6, etaMinutes: 15 },
      { teamApiId: 2, probability: 0.4, etaMinutes: 40 },
    ],
    reason: "Richting oost.",
    ...overrides,
  };
}

function fakePredictor(results: (unknown | Error)[]) {
  const prompts: string[] = [];
  const predictor: FoxPredictor = {
    async predict(prompt) {
      prompts.push(prompt);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { predictor, prompts };
}

function serviceAt(minutes: number, predictor: FoxPredictor | null) {
  return createPredictionService({ predictor, walkMinutes: walk, now: () => at(minutes) });
}

async function alpha() {
  await setAreaStatus("Alpha", "green");
  await makeTeam(1, "alpha", moveM(O, 1000, 0), "Rijn");
  await makeTeam(2, "alpha", moveM(O, 3000, 0), "Valken");
  await addObservation("alpha", at(0), O);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("recomputeArea", () => {
  test("stores pin, candidates with names/eta/walk minutes, confidence and why", async () => {
    await alpha();
    const { predictor, prompts } = fakePredictor([answer()]);
    const dto = await serviceAt(30, predictor).recomputeArea("Alpha");
    expect(prompts).toHaveLength(1);
    expect(dto.pin).toEqual({ lat: O[1], lng: O[0] + 0.005 });
    expect(dto.candidates.map((candidate) => [candidate.name, candidate.walkMinutes])).toEqual([
      ["Rijn", 10],
      ["Valken", 20],
    ]);
    expect(dto.candidates[0].eta).toEqual(at(45));
    expect(dto.confidence).toBe("medium");
    expect(dto.why).toBe("Richting oost.");
    expect(dto.stale).toBe(false);
    const [stored] = await listPredictions();
    expect(stored.area).toBe("alpha");
    expect((stored as Record<string, unknown>).signature).toBeUndefined();
    expect((stored as Record<string, unknown>).attemptedAt).toBeUndefined();
  });

  test("red status pauses without calling Gemini", async () => {
    await alpha();
    await setAreaStatus("Alpha", "red");
    const { predictor, prompts } = fakePredictor([]);
    const dto = await serviceAt(30, predictor).recomputeArea("alpha");
    expect(dto.paused).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  test("no trail or no groups: reason, no call", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", O);
    await setAreaStatus("Bravo", "green");
    const { predictor, prompts } = fakePredictor([]);
    expect((await serviceAt(0, predictor).recomputeArea("alpha")).reason).toBe("Nog geen locatie");
    expect((await serviceAt(0, predictor).recomputeArea("bravo")).reason).toBe("Geen groepen gekoppeld");
    expect(prompts).toHaveLength(0);
  });

  test("no API key: reason AI niet geconfigureerd", async () => {
    await alpha();
    expect((await serviceAt(0, null).recomputeArea("alpha")).reason).toBe("AI niet geconfigureerd");
  });

  test("retries once on invalid output, then succeeds", async () => {
    await alpha();
    const { predictor, prompts } = fakePredictor([answer({ pin: null }), answer()]);
    const dto = await serviceAt(30, predictor).recomputeArea("alpha");
    expect(prompts).toHaveLength(2);
    expect(dto.stale).toBe(false);
  });

  test("two failures keep the last good prediction and mark it stale", async () => {
    await alpha();
    await serviceAt(30, fakePredictor([answer()]).predictor).recomputeArea("alpha");
    const failing = fakePredictor([new GeminiError("Gemini-verzoek mislukt (HTTP 503)", true, 503), new GeminiError("Gemini-verzoek mislukt (HTTP 503)", true, 503)]);
    const dto = await serviceAt(45, failing.predictor).recomputeArea("alpha");
    expect(dto.stale).toBe(true);
    expect(dto.error).toBe("Gemini-verzoek mislukt (HTTP 503)");
    expect(dto.candidates).toHaveLength(2);
    expect(dto.updatedAt).toEqual(at(30));
  });

  test("manual visits reach the prompt and win over Gemini", async () => {
    await alpha();
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Manual });
    const { predictor, prompts } = fakePredictor([answer({ candidates: [{ teamApiId: 2, probability: 1, etaMinutes: 5 }] })]);
    const dto = await serviceAt(30, predictor).recomputeArea("alpha");
    expect(prompts[0]).toContain('"manualVisits":[{"teamApiId":1,"state":"visited"}]');
    expect(dto.visitedTeamApiIds).toEqual([1]);
  });
});

describe("recomputeDue", () => {
  test("recomputes on new input or after 10 minutes, not otherwise", async () => {
    await alpha();
    const { predictor, prompts } = fakePredictor([answer(), answer(), answer()]);
    expect((await serviceAt(0, predictor).recomputeDue()).recomputed).toEqual(["alpha"]);
    expect((await serviceAt(5, predictor).recomputeDue()).recomputed).toEqual([]);
    await addObservation("alpha", at(6), O, MarkerType.Spot);
    expect((await serviceAt(7, predictor).recomputeDue()).recomputed).toEqual(["alpha"]);
    expect((await serviceAt(17, predictor).recomputeDue()).recomputed).toEqual(["alpha"]);
    expect(prompts).toHaveLength(3);
  });

  test("after a failure the area waits 2 minutes", async () => {
    await alpha();
    const { predictor, prompts } = fakePredictor([new GeminiError("x", true), new GeminiError("x", true), answer()]);
    await serviceAt(0, predictor).recomputeDue();
    await addObservation("alpha", at(1), O, MarkerType.Spot);
    await serviceAt(1, predictor).recomputeDue();
    expect(prompts).toHaveLength(2);
    await serviceAt(3, predictor).recomputeDue();
    expect(prompts).toHaveLength(3);
    expect((await Prediction.findOne({ area: "alpha" }).lean())?.stale).toBe(false);
  });

  test("Gemini calls never overlap", async () => {
    await alpha();
    await setAreaStatus("Bravo", "green");
    await makeTeam(3, "bravo", O);
    await addObservation("bravo", at(0), O);
    let running = 0;
    let maxRunning = 0;
    const predictor: FoxPredictor = {
      async predict(prompt) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return prompt.includes('"area":"bravo"') ? answer({ candidates: [{ teamApiId: 3, probability: 1, etaMinutes: 1 }] }) : answer();
      },
    };
    const service = serviceAt(0, predictor);
    await Promise.all([service.recomputeDue(), service.recomputeArea("bravo")]);
    expect(maxRunning).toBe(1);
  });
});
