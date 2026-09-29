import { Prediction } from "../../models/prediction.model";
import { assertGeneration, currentGeneration, DemoSwitchedError, isDemoSwitchInProgress } from "../../demo/demo-mode";
import { GeminiError } from "../gemini.client";
import { FAILURE_BACKOFF_MS, RECOMPUTE_INTERVAL_MS, RETRY_DELAY_MS } from "./constants";
import { gatherFacts, listAreaNames, loadAreaInputs, signatureOf, type AreaInputs } from "./facts";
import type { FoxPredictor } from "./gemini-predictor";
import { buildPrompt } from "./prompt";
import type { ObservationKind } from "./types";
import { validatePrediction, type Confidence, type ValidPrediction } from "./validate";
import type { WalkMinutes } from "./walking";

export interface PredictionDeps {
  /** null when GEMINI_API_KEY is not set */
  predictor: FoxPredictor | null;
  walkMinutes: WalkMinutes;
  now?: () => Date;
  /** Pause before a retry (default: real timer) */
  sleep?: (ms: number) => Promise<void>;
}

export interface CandidateDto {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
  probability: number;
  eta: Date;
  walkMinutes: number;
}

export interface PredictionDto {
  area: string;
  status: string;
  paused: boolean;
  reason?: string;
  updatedAt: Date;
  round: number;
  estimate: boolean;
  stale: boolean;
  error?: string;
  lastObservation: { time: Date; lng: number; lat: number; kind: ObservationKind } | null;
  pin: { lat: number; lng: number } | null;
  confidence: Confidence | null;
  candidates: CandidateDto[];
  visitedTeamApiIds: number[];
  why: string;
}

/** Stored predictions for the API (without the signature and the attempt time). */
export async function listPredictions() {
  return Prediction.find({}, { _id: 0, __v: 0, signature: 0, attemptedAt: 0 }).sort({ area: 1 }).lean();
}

function errorMessage(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  if (error instanceof Error && error.name === "InvalidPredictionError") return `Ongeldig AI-antwoord: ${error.message}`;
  return "AI-voorspelling mislukt";
}

/**
 * Gemini fox prediction. The predictor and the walking router are injected so tests run without network.
 * All runs go through one queue: never two Gemini calls at the same time.
 */
export function createPredictionService(deps: PredictionDeps) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<PredictionDto>>();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  function baseDto(inputs: AreaInputs, at: Date): PredictionDto {
    const last = inputs.trail.at(-1);
    return {
      area: inputs.area,
      status: inputs.status,
      paused: false,
      updatedAt: at,
      round: inputs.round,
      estimate: false,
      stale: false,
      lastObservation: last ? { time: last.time, lng: last.lng, lat: last.lat, kind: last.kind } : null,
      pin: null,
      confidence: null,
      candidates: [],
      visitedTeamApiIds: [],
      why: "",
    };
  }

  async function askGemini(predictor: FoxPredictor, prompt: string, facts: Parameters<typeof validatePrediction>[1]): Promise<ValidPrediction> {
    try {
      return validatePrediction(await predictor.predict(prompt), facts);
    } catch (first) {
      if (first instanceof GeminiError && ((!first.retryable && first.status !== undefined) || first.status === 429)) throw first;
      await sleep(RETRY_DELAY_MS);
      return validatePrediction(await predictor.predict(prompt), facts);
    }
  }

  async function compute(inputs: AreaInputs, generation: number): Promise<PredictionDto> {
    const at = now();
    const signature = signatureOf(inputs);
    const dto = baseDto(inputs, at);
    const store = async (value: PredictionDto) => {
      assertGeneration(generation);
      await Prediction.replaceOne({ area: inputs.area }, { ...value, signature, attemptedAt: at }, { upsert: true });
      return value;
    };

    if (inputs.groups.length === 0) return store({ ...dto, reason: "Geen groepen gekoppeld" });
    if (inputs.status === "red") return store({ ...dto, paused: true, reason: "Inactief, voorspelling gepauzeerd" });
    if (inputs.trail.length === 0) return store({ ...dto, reason: "Nog geen locatie" });
    if (!deps.predictor) return store({ ...dto, reason: "AI niet geconfigureerd" });

    const facts = await gatherFacts(inputs, deps.walkMinutes, at);
    try {
      const result = await askGemini(deps.predictor, buildPrompt(facts), facts);
      const byId = new Map(facts.groups.map((group) => [group.teamApiId, group]));
      return store({
        ...dto,
        round: result.round,
        estimate: facts.estimate,
        pin: result.pin,
        confidence: result.confidence,
        visitedTeamApiIds: result.visitedTeamApiIds,
        why: result.why,
        candidates: result.candidates.map((candidate) => {
          const group = byId.get(candidate.teamApiId)!;
          return {
            teamApiId: group.teamApiId,
            name: group.name,
            lng: group.lng,
            lat: group.lat,
            probability: candidate.probability,
            eta: new Date(at.getTime() + candidate.etaMinutes * 60_000),
            walkMinutes: group.walkMinutes,
          };
        }),
      });
    } catch (error) {
      if (error instanceof DemoSwitchedError) throw error;
      const previous = await Prediction.findOne({ area: inputs.area }, { _id: 0, __v: 0, signature: 0, attemptedAt: 0 }).lean();
      // Only a real earlier prediction (has a pin) is worth keeping; status-only docs are not.
      const base = previous && (previous as PredictionDto).pin ? (previous as PredictionDto) : dto;
      const { reason: _reason, ...rest } = base;
      const kept: PredictionDto = { ...rest, status: inputs.status, paused: false, lastObservation: dto.lastObservation };
      assertGeneration(generation);
      // Keep the old signature so the next tick still sees the new inputs as changed
      await Prediction.updateOne(
        { area: inputs.area },
        { $set: { ...kept, stale: true, error: errorMessage(error), attemptedAt: at }, $unset: { reason: "" }, $setOnInsert: { signature: "" } },
        { upsert: true },
      );
      return { ...kept, stale: true, error: errorMessage(error) };
    }
  }

  /** Recompute one area now (e.g. after a manual visit change). */
  function recomputeArea(area: string): Promise<PredictionDto> {
    const name = area.toLowerCase();
    // A run that is queued but not started yet will load fresh inputs anyway: share it.
    const queued = pending.get(name);
    if (queued) return queued;
    const generation = currentGeneration();
    const run = serial(async () => {
      pending.delete(name);
      return compute(await loadAreaInputs(name), generation);
    });
    pending.set(name, run);
    return run;
  }

  /**
   * Recompute every area whose inputs changed or whose prediction is at least 10 minutes old.
   * A failed area waits 2 minutes. One failing area never stops the others.
   */
  async function recomputeDue(): Promise<{ recomputed: string[]; failed: { area: string; error: unknown }[] }> {
    const recomputed: string[] = [];
    const failed: { area: string; error: unknown }[] = [];
    const generation = currentGeneration();
    for (const area of await listAreaNames()) {
      if (isDemoSwitchInProgress() || generation !== currentGeneration()) break;
      try {
        const done = await serial(async () => {
          const inputs = await loadAreaInputs(area);
          const previous = await Prediction.findOne({ area }, { signature: 1, updatedAt: 1, stale: 1, attemptedAt: 1 }).lean();
          const t = now().getTime();
          if (previous?.stale && previous.attemptedAt && t - previous.attemptedAt.getTime() < FAILURE_BACKOFF_MS) return false;
          const fresh = previous && !previous.stale && previous.signature === signatureOf(inputs) && t - new Date(previous.updatedAt).getTime() < RECOMPUTE_INTERVAL_MS;
          if (fresh) return false;
          await compute(inputs, generation);
          return true;
        });
        if (done) recomputed.push(area);
      } catch (error) {
        if (error instanceof DemoSwitchedError) break;
        failed.push({ area, error });
      }
    }
    return { recomputed, failed };
  }

  return { recomputeArea, recomputeDue };
}
