import { AREAS } from "../../constants/areas";
import { Prediction } from "../../models/prediction.model";
import { assertGeneration, currentGeneration, DemoSwitchedError, isDemoSwitchInProgress } from "../../demo/demo-mode";
import { GeminiError } from "../gemini.client";
import { FAILURE_BACKOFF_MS, GEMINI_PAUSE_MAX_MS, GEMINI_PAUSE_MS, RECOMPUTE_INTERVAL_MS, RETRY_DELAY_MS } from "./constants";
import { gatherFacts, listAreaNames, loadAreaInputs, signatureOf, type AreaInputs } from "./facts";
import type { FoxPredictor } from "./gemini-predictor";
import { buildPrompt } from "./prompt";
import type { ObservationKind } from "./types";
import { validatePrediction, type Confidence, type ValidPrediction } from "./validate";
import type { WalkMinutes } from "./walking";

export interface PredictionDeps {
  /** The predictor right now; null without a Gemini key */
  predictor: () => FoxPredictor | null;
  walkMinutes: WalkMinutes;
  now?: () => Date;
  /** Pause before a retry (default: real timer) */
  sleep?: (ms: number) => Promise<void>;
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
  visitedTeamApiIds: number[];
  why: string;
}

/** Stored predictions of the known areas for the API (without the signature and the attempt time). */
export async function listPredictions() {
  return Prediction.find({ area: { $in: AREAS } }, { _id: 0, __v: 0, signature: 0, attemptedAt: 0, candidates: 0 }).sort({ area: 1 }).lean();
}

/** Gemini is not called while the circuit breaker is open. */
class GeminiPausedError extends GeminiError {
  constructor(remainingMs: number) {
    super(`AI gepauzeerd na fouten, nieuwe poging over ${Math.ceil(remainingMs / 60_000)} min`, true);
  }
}

/** Rate limited, overloaded or not answering: give Gemini a break instead of asking for every area. */
function isOverloaded(error: unknown): boolean {
  if (!(error instanceof GeminiError) || error instanceof GeminiPausedError) return false;
  return error.status === 429 || error.status === 503 || (error.retryable && error.status === undefined);
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
  const sleep = deps.sleep ?? Bun.sleep;
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<PredictionDto>>();
  // Circuit breaker for Gemini (see isOverloaded)
  let pausedUntil = 0;
  let pauses = 0;

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
    const predictor = deps.predictor();
    if (!predictor) return store({ ...dto, reason: "AI niet geconfigureerd" });

    const facts = await gatherFacts(inputs, deps.walkMinutes, at);
    try {
      const remaining = pausedUntil - at.getTime();
      if (remaining > 0) throw new GeminiPausedError(remaining);
      const result = await askGemini(predictor, buildPrompt(facts), facts);
      pauses = 0;
      return store({
        ...dto,
        round: result.round,
        estimate: facts.estimate,
        pin: result.pin,
        confidence: result.confidence,
        visitedTeamApiIds: result.visitedTeamApiIds,
        why: result.why,
      });
    } catch (error) {
      if (error instanceof DemoSwitchedError) throw error;
      if (isOverloaded(error)) {
        pausedUntil = now().getTime() + Math.min(GEMINI_PAUSE_MS * 2 ** pauses, GEMINI_PAUSE_MAX_MS);
        pauses++;
      }
      const previous = await Prediction.findOne({ area: inputs.area }, { _id: 0, __v: 0, signature: 0, attemptedAt: 0, candidates: 0 }).lean();
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
    // Predictions of names that are not an area (e.g. from a broken /areas answer) are never shown: drop them
    await Prediction.deleteMany({ area: { $nin: AREAS } });
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
