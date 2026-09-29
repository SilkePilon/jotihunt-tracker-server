# Gemini Fox Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic fox prediction with Gemini. The server gathers facts (trail, groups, ORS walking minutes, manual visits), and Gemini returns visited groups, a best-guess pin and the top 3 groups with probability and ETA. The client shows this as compact cards and a pulsing map pin.

**Architecture:** Server pipeline per area: `loadAreaInputs` (DB) → `walkMinutes` (ORS matrix with cache, breaker and fallback) → `buildPrompt` → `FoxPredictor.predict` (Gemini REST, JSON schema) → `validatePrediction` → store in `Prediction`. The cron triggers every minute; an area is only called when its signature changed or 10 minutes passed. The client reads `GET /predictions` and `GET /visits`, as it does now.

**Tech Stack:** Bun + TypeScript, express 5, mongoose 9, axios. Gemini REST `generateContent`. Client: React 19 + Vite, shadcn/ui, Tailwind 4, react-map-gl/maplibre, SWR. Tests: `bun test`, MongoDB test database (`MONGO_URI_TEST`).

Repos (both git, branch `main`):
- Server: `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server` (called SERVER below)
- Client: `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client` (called CLIENT below)

Spec: `SERVER/docs/superpowers/specs/2026-09-29-gemini-prediction-design.md`

## Global Constraints

- Prediction model env: `GEMINI_PREDICTION_MODEL`, default `gemini-pro-latest`. Key: the existing `GEMINI_API_KEY`.
- Trigger: signature change, or ≥ 10 min since `updatedAt`. After a failed run, wait ≥ 2 min before retrying that area.
- One Gemini call at a time, server-wide.
- Red status = `paused`, no Gemini call.
- Output per area: `pin`, `confidence` (`low|medium|high`), up to 3 candidates (probabilities normalised to sum 1), `visitedTeamApiIds`, `round`, `why` (≤ 120 characters, Dutch).
- Pin more than 15 km from the last trail point = invalid.
- Only ORS walking minutes as extra input. No transit, no hint texts, no feedback from past predictions.
- UI text is in Dutch and minimal.
- The API key must never appear in error messages or logs.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## File map

SERVER `src/services/prediction/`:
- `walking.ts` (new): the ORS matrix with cache, breaker and straight-line fallback. Returns walking minutes.
- `facts.ts` (new): loads the area inputs from the DB, computes the signature and assembles `AreaFacts`.
- `prompt.ts` (new): `buildPrompt(facts)`.
- `gemini-predictor.ts` (new): `createGeminiPredictor`.
- `validate.ts` (new): `validatePrediction`.
- `prediction.service.ts` (rewrite): `createPredictionService({ predictor, walkMinutes, now })`.
- `visit.service.ts` (rewrite): manual overrides plus AI visits in `listCurrentVisits`.
- `instance.ts`, `constants.ts`, `types.ts`, `routing.ts`, `straight-line.router.ts`, `ors.client.ts` (trim).
- Delete: `scoring`, `tour`, `learning`, `zones`, `transit`, `transitous.client`, `overpass.client`, `transit-stop.service`, `visits`, `replay.test`, `learning.test` and the other matching `*.test.ts` files.

Other SERVER files:
- `src/services/gemini.client.ts`: extract `generateJson`.
- `src/models/prediction.model.ts`: new schema.
- Delete `src/models/prediction-model.model.ts` and `src/models/transit-stop.model.ts`.
- `src/controllers/predictions.controller.ts`, `src/crons/prediction.cron.ts`, `src/routes/admin.route.ts`, `src/index.ts`, `src/scripts/seed-prediction.ts`, `src/demo/demo-world.ts`, `src/demo/generator/generate-world.ts`.
- `.env.example` and `../.env.example`.

CLIENT `src/`:
- `types/Prediction.ts`, `lib/prediction.ts`, `lib/prediction.test.ts`.
- `components/sidebar/PredictionList.tsx` (card UI).
- `components/layers/Predictions.tsx` (pin, line, badges).
- `components/map/VisitControls.tsx` (label "AI").
- `lib/hunt-reports.ts` (`nearestArea` uses the pin).

---

### Task 1: Shared Gemini JSON call

**Files:**
- Modify: `SERVER/src/services/gemini.client.ts`
- Test: `SERVER/src/services/gemini.client.test.ts` (existing tests must keep passing; add one)

**Interfaces:**
- Produces: `generateJson(options: { http: GeminiHttp; apiKey: string; model: string; parts: unknown[]; generationConfig?: Record<string, unknown>; timeoutMs: number }): Promise<string>`. It returns the concatenated text of the answer and throws `GeminiError` with the same mapping as today.

- [ ] **Step 1: Write the failing test.** Append to `gemini.client.test.ts`:

```ts
import { generateJson } from "./gemini.client";

describe("generateJson", () => {
  test("posts parts and generationConfig with the key header, returns the text", async () => {
    const { http, calls } = fakeHttp(answer('{"ok":true}'));
    const text = await generateJson({ http, apiKey: API_KEY, model: "m-1", parts: [{ text: "hi" }], generationConfig: { temperature: 0.2 }, timeoutMs: 5000 });
    expect(text).toBe('{"ok":true}');
    expect(calls[0].url).toContain("/models/m-1:generateContent");
    expect(calls[0].config).toEqual({ headers: { "x-goog-api-key": API_KEY }, timeout: 5000 });
    expect(calls[0].body).toEqual({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
  });

  test("429 is retryable and hides the key", async () => {
    const { http } = fakeHttp(httpError(429));
    const error = await readError(generateJson({ http, apiKey: API_KEY, model: "m", parts: [], timeoutMs: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `cd SERVER && bun test src/services/gemini.client.test.ts`. Expected: FAIL (`generateJson` is not exported).

- [ ] **Step 3: Implement.** In `gemini.client.ts`, replace the body of `createGeminiClient` and add `generateJson`:

```ts
type GenerateContentResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

/** One generateContent call with a JSON answer. Returns the answer text; throws GeminiError (never with the key). */
export async function generateJson({
  http,
  apiKey,
  model,
  parts,
  generationConfig = {},
  timeoutMs,
}: {
  http: GeminiHttp;
  apiKey: string;
  model: string;
  parts: unknown[];
  generationConfig?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = { contents: [{ parts }], generationConfig: { responseMimeType: "application/json", ...generationConfig } };
  let response: { data: GenerateContentResponse };
  try {
    response = await http.post<GenerateContentResponse>(url, body, { headers: { "x-goog-api-key": apiKey }, timeout: timeoutMs });
  } catch (error) {
    // Only the status code is used: the error object holds the request headers (with the key)
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    throw new GeminiError(status ? `Gemini-verzoek mislukt (HTTP ${status})` : "Gemini niet bereikbaar", !status || status === 429 || status >= 500, status);
  }
  return response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

export function createGeminiClient({ apiKey, model, http }: { apiKey: string; model: string; http: GeminiHttp }): StickerReader {
  return {
    async readSticker(base64: string, mimeType: string): Promise<StickerReading> {
      const text = await generateJson({
        http,
        apiKey,
        model,
        parts: [{ text: STICKER_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }],
        generationConfig: { temperature: 0 },
        timeoutMs: TIMEOUT_MS,
      });
      try {
        return parseStickerReading(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
```

Remove the old inline `type GenerateContentResponse` line, so it is defined only once.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `bun test src/services/gemini.client.test.ts`. Expected: all PASS, including the old sticker tests.

- [ ] **Step 5: Commit.**

```bash
git add src/services/gemini.client.ts src/services/gemini.client.test.ts
git commit -m "refactor: extract generateJson from Gemini sticker client"
```

---

### Task 2: Walking minutes (ORS matrix only) and trimmed routing

**Files:**
- Create: `SERVER/src/services/prediction/walking.ts`
- Create: `SERVER/src/services/prediction/walking.test.ts`
- Modify: `routing.ts`, `straight-line.router.ts`, `ors.client.ts`, `ors.client.test.ts`, `straight-line.router.test.ts`, `constants.ts`, `types.ts`

**Interfaces:**
- Consumes: `readCacheEntry` and `writeCache` (`routing-cache.ts`), `createOrsRouter`, `straightLineRouter`.
- Produces:
  - `WalkingRouter` = `{ matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult> }`.
  - `createWalkMinutes(deps: { walking: WalkingRouter; fallback: WalkingRouter; now?: () => Date }): WalkMinutes`.
  - `type WalkMinutes = (from: LngLat, to: LngLat[]) => Promise<{ minutes: number[]; estimate: boolean }>`, with minutes rounded to integers.
  - `coordKey(p: LngLat): string`.

- [ ] **Step 1: Trim `routing.ts`.** Replace the file with:

```ts
import type { LngLat } from "./types";

/**
 * How a routing failure should be handled:
 * - `request`: only this request is bad (e.g. 400/404 "no routable point within 350 m").
 * - `permanent`: cannot resolve itself (no/invalid API key, 401/403); stop calling until the config changes.
 * - `temporary`: outage, rate limit, timeout or network error (429/5xx); retry after a cooldown.
 */
export type RoutingFailureKind = "request" | "permanent" | "temporary";

/** ORS could not answer: no key, HTTP error, quota. Callers fall back to estimates. */
export class RoutingUnavailableError extends Error {
  readonly kind: RoutingFailureKind;

  constructor(message: string, options: { kind?: RoutingFailureKind } = {}) {
    super(message);
    this.name = "RoutingUnavailableError";
    this.kind = options.kind ?? "temporary";
  }
}

export interface MatrixResult {
  /** durationsS[source][destination] in seconds; null when unreachable */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
}

export interface WalkingRouter {
  matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult>;
}
```

- [ ] **Step 2: Trim `types.ts`.** Replace it with:

```ts
export type LngLat = [number, number];

export type ObservationKind = "hint" | "hunt" | "spot";

export interface GroupRef {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
}
```

- [ ] **Step 3: Trim `constants.ts`.** Replace it with:

```ts
/** ORS foot-walking speed (5 km/h) in metres per minute. */
export const WALK_M_PER_MIN = 5000 / 60;
/** Straight-line distance × this factor approximates the walking distance. */
export const DETOUR_FACTOR = 1.3;
export const TOP_CANDIDATES = 3;
/** A prediction older than this is recomputed even without new inputs. */
export const RECOMPUTE_INTERVAL_MS = 10 * 60 * 1000;
/** After a failed Gemini run, the area waits this long before trying again. */
export const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
/** A pin further than this from the last trail point is rejected. */
export const MAX_PIN_DISTANCE_M = 15_000;
/** Reasoning shown behind the ⓘ is cut to this many characters. */
export const MAX_WHY_LENGTH = 120;
/** ETAs further than this ahead are clamped. */
export const MAX_ETA_MINUTES = 600;
/** After a RoutingUnavailableError, ORS is treated as down for this long before being retried. */
export const ORS_COOLDOWN_MS = 5 * 60 * 1000;
/** A request ORS rejected as unanswerable (400/404) is answered from the cached fallback for this long. */
export const ORS_REQUEST_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
export const USER_AGENT = "jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)";
```

- [ ] **Step 4: Trim `straight-line.router.ts`.** Replace it with:

```ts
import { DETOUR_FACTOR, WALK_M_PER_MIN } from "./constants";
import { distanceM } from "./geo";
import type { WalkingRouter } from "./routing";
import type { LngLat } from "./types";

/** Walking time estimate: straight line × 1.3 at 5 km/h, in seconds. */
export function straightLineSeconds(a: LngLat, b: LngLat): number {
  return ((distanceM(a, b) * DETOUR_FACTOR) / WALK_M_PER_MIN) * 60;
}

/** Fallback router used when ORS is unavailable (and as the routing mock in tests). */
export const straightLineRouter: WalkingRouter = {
  async matrix(sources, destinations) {
    return {
      durationsS: sources.map((source) => destinations.map((destination) => straightLineSeconds(source, destination))),
      distancesM: sources.map((source) => destinations.map((destination) => distanceM(source, destination) * DETOUR_FACTOR)),
    };
  },
};
```

In `straight-line.router.test.ts`, delete every test that uses `route` or `isochrones`, and keep the `straightLineSeconds` and `matrix` tests.

- [ ] **Step 5: Trim `ors.client.ts`.** Make these changes:
  - Delete `parseOrsRoute` and `parseOrsIsochrones`.
  - Set `ORS_DAILY_LIMITS = { matrix: 500 } as const` and `ORS_MINUTE_LIMITS = { matrix: 40 } as const`.
  - Set `counters` to `{ matrix: new DailyCounter(ORS_DAILY_LIMITS.matrix) }` and `budgets` to `{ matrix: new MinuteBudget(ORS_MINUTE_LIMITS.matrix) }`.
  - Remove the `route` and `isochrones` methods from the returned object.
  - Change the imports to `import type { LngLat } from "./types";` only if `LngLat` is still used; otherwise drop that import. Also drop `RouteResult`.

  In `ors.client.test.ts`:
  - Delete the tests "directions", "isochrones keyed by minutes" and "requests directions and isochrones".
  - Wherever a test builds `counters` or `budgets` with `directions` or `isochrones` keys, keep only `matrix`.
  - Wherever a test calls `router.route(...)` or `router.isochrones(...)`, switch it to `router.matrix([[5, 52]], [[5.1, 52]])`.
  - Update "uses the free-plan per-minute limits" to expect `{ matrix: 40 }`.

- [ ] **Step 6: Write the failing test** `walking.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RoutingCache } from "../../models/routing-cache.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { RoutingUnavailableError, type WalkingRouter } from "./routing";
import { straightLineRouter } from "./straight-line.router";
import type { LngLat } from "./types";
import { createWalkMinutes } from "./walking";

void RoutingCache;
const A: LngLat = [5.4866, 52.0806];
const B: LngLat = [5.5, 52.09];

function countingRouter(inner: WalkingRouter) {
  let calls = 0;
  return {
    router: { matrix: (s: LngLat[], d: LngLat[]) => (calls++, inner.matrix(s, d)) } as WalkingRouter,
    calls: () => calls,
  };
}
const failing = (kind: "request" | "permanent" | "temporary"): WalkingRouter => ({
  matrix: async () => {
    throw new RoutingUnavailableError("down", { kind });
  },
});

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("createWalkMinutes", () => {
  test("rounds ORS seconds to minutes and caches the result", async () => {
    const ors = countingRouter({ matrix: async () => ({ durationsS: [[600, 1250]], distancesM: [[0, 0]] }) });
    const walk = createWalkMinutes({ walking: ors.router, fallback: straightLineRouter });
    expect(await walk(A, [B, A])).toEqual({ minutes: [10, 21], estimate: false });
    expect(await walk(A, [B, A])).toEqual({ minutes: [10, 21], estimate: false });
    expect(ors.calls()).toBe(1);
  });

  test("falls back to straight line and flags estimate when ORS is down", async () => {
    const walk = createWalkMinutes({ walking: failing("temporary"), fallback: straightLineRouter });
    const result = await walk(A, [B]);
    expect(result.estimate).toBe(true);
    expect(result.minutes[0]).toBeGreaterThan(0);
  });

  test("a temporary failure opens the breaker: ORS is skipped until the cooldown ends", async () => {
    let now = 0;
    const ors = countingRouter(failing("temporary"));
    const walk = createWalkMinutes({ walking: ors.router, fallback: straightLineRouter, now: () => new Date(now) });
    await walk(A, [B]);
    await walk(B, [A]);
    expect(ors.calls()).toBe(1);
    now = 6 * 60 * 1000;
    await walk([5.6, 52.1], [A]);
    expect(ors.calls()).toBe(2);
  });

  test("null ORS durations use the straight-line estimate", async () => {
    const walk = createWalkMinutes({ walking: { matrix: async () => ({ durationsS: [[null]], distancesM: [[null]] }) }, fallback: straightLineRouter });
    const result = await walk(A, [B]);
    expect(result.minutes[0]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run the test and confirm it fails.** Run `bun test src/services/prediction/walking.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 8: Implement** `walking.ts`:

```ts
import { createHash } from "node:crypto";
import { ORS_COOLDOWN_MS, ORS_REQUEST_FALLBACK_TTL_MS } from "./constants";
import { RoutingUnavailableError, type MatrixResult, type WalkingRouter } from "./routing";
import { readCacheEntry, writeCache } from "./routing-cache";
import { straightLineSeconds } from "./straight-line.router";
import type { LngLat } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WalkMinutes = (from: LngLat, to: LngLat[]) => Promise<{ minutes: number[]; estimate: boolean }>;

/** Stable cache key for a coordinate (~1 m precision). */
export function coordKey([lng, lat]: LngLat): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * Walking minutes from one point to many, via the ORS matrix. Results are cached for a day.
 * Circuit breaker (for the life of this instance): a permanent failure (no/rejected key) stops ORS for good;
 * a temporary failure skips ORS for ORS_COOLDOWN_MS; a request failure (400/404) caches the fallback for 6 h.
 */
export function createWalkMinutes(deps: { walking: WalkingRouter; fallback: WalkingRouter; now?: () => Date }): WalkMinutes {
  const now = deps.now ?? (() => new Date());
  const breaker: { permanent: boolean; openUntil: number | null } = { permanent: false, openUntil: null };

  async function matrix(key: string, from: LngLat, to: LngLat[]): Promise<{ result: MatrixResult; estimate: boolean }> {
    const hit = await readCacheEntry<MatrixResult>(key);
    if (hit) return { result: hit.value, estimate: hit.estimate };
    if (breaker.permanent || (breaker.openUntil !== null && now().getTime() < breaker.openUntil)) {
      return { result: await deps.fallback.matrix([from], to), estimate: true };
    }
    try {
      const result = await deps.walking.matrix([from], to);
      await writeCache(key, result, DAY_MS);
      breaker.openUntil = null;
      return { result, estimate: false };
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      const result = await deps.fallback.matrix([from], to);
      if (error.kind === "request") await writeCache(key, result, ORS_REQUEST_FALLBACK_TTL_MS, { estimate: true });
      else if (error.kind === "permanent") breaker.permanent = true;
      else breaker.openUntil = now().getTime() + ORS_COOLDOWN_MS;
      return { result, estimate: true };
    }
  }

  return async (from, to) => {
    if (to.length === 0) return { minutes: [], estimate: false };
    const key = `walk:${coordKey(from)}:${createHash("sha1").update(to.map(coordKey).join(";")).digest("hex")}`;
    const { result, estimate } = await matrix(key, from, to);
    const minutes = to.map((point, index) => Math.round((result.durationsS[0]?.[index] ?? straightLineSeconds(from, point)) / 60));
    return { minutes, estimate };
  };
}
```

- [ ] **Step 9: Run the tests and confirm they pass.** Run `bun test src/services/prediction/walking.test.ts src/services/prediction/ors.client.test.ts src/services/prediction/straight-line.router.test.ts`. Expected: PASS. The full suite still fails at this point, because the old modules import the removed types. Task 6 fixes that. Do not run `tsc` yet.

- [ ] **Step 10: Commit.**

```bash
git add src/services/prediction/{walking.ts,walking.test.ts,routing.ts,types.ts,constants.ts,straight-line.router.ts,straight-line.router.test.ts,ors.client.ts,ors.client.test.ts}
git commit -m "feat: walking-minutes matrix with cache and breaker for Gemini prediction"
```

---

### Task 3: Facts gathering

**Files:**
- Create: `SERVER/src/services/prediction/facts.ts`
- Create: `SERVER/src/services/prediction/facts.test.ts`

**Interfaces:**
- Consumes: `WalkMinutes` (Task 2), and the `Area`, `Team`, `Marker`, `GroupVisit` and `Prediction` models.
- Produces:

```ts
export interface TrailPoint { id: string; time: Date; kind: ObservationKind; lng: number; lat: number }
export interface ManualVisitFact { teamApiId: number; state: "visited" | "not_visited" }
export interface AreaInputs { area: string; status: string; round: number; groups: GroupRef[]; trail: TrailPoint[]; manualVisits: ManualVisitFact[] }
export interface GroupFact extends GroupRef { walkMinutes: number }
export interface AreaFacts extends Omit<AreaInputs, "groups"> { now: Date; groups: GroupFact[]; estimate: boolean }
export async function loadAreaInputs(area: string): Promise<AreaInputs>
export function signatureOf(inputs: AreaInputs): string
export async function gatherFacts(inputs: AreaInputs, walk: WalkMinutes, now: Date): Promise<AreaFacts>
export async function listAreaNames(): Promise<string[]>
```

`round` comes from the stored prediction (default 1). `manualVisits` are the manual `GroupVisit` docs of that round.

- [ ] **Step 1: Write the failing test** `facts.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { gatherFacts, listAreaNames, loadAreaInputs, signatureOf } from "./facts";
import { moveM } from "./geo";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedAlpha() {
  await setAreaStatus("Alpha", "green");
  await makeTeam(2, "alpha", moveM(O, 3000, 0));
  await makeTeam(1, "alpha", moveM(O, 1000, 0));
  await addObservation("alpha", at(60), moveM(O, 200, 0), MarkerType.Spot);
  await addObservation("alpha", at(0), O);
}

describe("loadAreaInputs", () => {
  test("status, groups sorted by id, trail sorted by time, round 1 by default", async () => {
    await seedAlpha();
    const inputs = await loadAreaInputs("alpha");
    expect(inputs.status).toBe("green");
    expect(inputs.round).toBe(1);
    expect(inputs.groups.map((group) => group.teamApiId)).toEqual([1, 2]);
    expect(inputs.trail.map((point) => point.kind)).toEqual(["hint", "spot"]);
    expect(inputs.manualVisits).toEqual([]);
  });

  test("manual visits of the stored round only", async () => {
    await seedAlpha();
    await Prediction.create({ area: "alpha", updatedAt: at(0), round: 2 });
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: "visited", source: "manual" });
    await GroupVisit.create({ area: "alpha", teamApiId: 2, round: 2, state: "not_visited", source: "manual" });
    const inputs = await loadAreaInputs("alpha");
    expect(inputs.round).toBe(2);
    expect(inputs.manualVisits).toEqual([{ teamApiId: 2, state: "not_visited" }]);
  });
});

describe("signatureOf", () => {
  test("changes on a new marker, status or manual visit; stable otherwise", async () => {
    await seedAlpha();
    const base = signatureOf(await loadAreaInputs("alpha"));
    expect(signatureOf(await loadAreaInputs("alpha"))).toBe(base);
    await addObservation("alpha", at(90), O, MarkerType.Hunt);
    const withHunt = signatureOf(await loadAreaInputs("alpha"));
    expect(withHunt).not.toBe(base);
    await setAreaStatus("Alpha", "orange");
    expect(signatureOf(await loadAreaInputs("alpha"))).not.toBe(withHunt);
  });
});

describe("gatherFacts", () => {
  test("walk minutes from the last trail point, estimate passed through", async () => {
    await seedAlpha();
    const inputs = await loadAreaInputs("alpha");
    let from: LngLat | null = null;
    const facts = await gatherFacts(
      inputs,
      async (origin, to) => {
        from = origin;
        return { minutes: to.map((_, index) => 10 + index), estimate: true };
      },
      at(120),
    );
    const last = inputs.trail[1];
    expect(from).toEqual([last.lng, last.lat]);
    expect(facts.groups.map((group) => group.walkMinutes)).toEqual([10, 11]);
    expect(facts.estimate).toBe(true);
    expect(facts.now).toEqual(at(120));
  });

  test("no trail: no routing, walk minutes 0", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", O);
    const facts = await gatherFacts(await loadAreaInputs("alpha"), async () => {
      throw new Error("must not route");
    }, at(0));
    expect(facts.groups[0].walkMinutes).toBe(0);
  });
});

test("listAreaNames merges areas and team areas, lowercased", async () => {
  await setAreaStatus("Alpha", "green");
  await makeTeam(1, "Bravo", O);
  expect(await listAreaNames()).toEqual(["alpha", "bravo"]);
});
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `bun test src/services/prediction/facts.test.ts`. Expected: FAIL (module not found). The `Prediction` schema is replaced in Task 6; `Prediction.create({ area, updatedAt, round })` works with both the old and the new schema.

- [ ] **Step 3: Implement** `facts.ts`:

```ts
import { createHash } from "node:crypto";
import { Area } from "../../models/area.model";
import { GroupVisit, VisitSource } from "../../models/group-visit.model";
import { Marker } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";
import type { GroupRef, LngLat, ObservationKind } from "./types";
import type { WalkMinutes } from "./walking";

export interface TrailPoint {
  id: string;
  time: Date;
  kind: ObservationKind;
  lng: number;
  lat: number;
}

export interface ManualVisitFact {
  teamApiId: number;
  state: "visited" | "not_visited";
}

export interface AreaInputs {
  area: string;
  status: string;
  round: number;
  groups: GroupRef[];
  trail: TrailPoint[];
  manualVisits: ManualVisitFact[];
}

export interface GroupFact extends GroupRef {
  walkMinutes: number;
}

export interface AreaFacts extends Omit<AreaInputs, "groups"> {
  now: Date;
  groups: GroupFact[];
  /** Walk minutes are straight-line estimates (ORS unavailable) */
  estimate: boolean;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase names of all known areas (from the Jotihunt areas and the groups' areas). */
export async function listAreaNames(): Promise<string[]> {
  const [areaNames, teamAreas] = await Promise.all([Area.distinct("name"), Team.distinct("area")]);
  const names = [...areaNames, ...teamAreas].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/** Everything the prediction needs from the database for one (lowercase) area. */
export async function loadAreaInputs(area: string): Promise<AreaInputs> {
  const nameRegex = new RegExp(`^${escapeRegExp(area)}$`, "i");
  const [areaDoc, teams, markers, stored] = await Promise.all([
    Area.findOne({ name: nameRegex }).lean(),
    Team.find({ area: nameRegex }).lean(),
    Marker.find({ area: nameRegex }).sort({ time: 1 }).lean(),
    Prediction.findOne({ area }, { round: 1 }).lean(),
  ]);
  const round = stored?.round ?? 1;
  const visits = await GroupVisit.find({ area, round, source: VisitSource.Manual }).sort({ teamApiId: 1 }).lean();
  return {
    area,
    status: areaDoc?.status ?? "unknown",
    round,
    groups: teams
      .map((team) => ({ teamApiId: team.apiId, name: team.name, lng: team.location.coordinates[0], lat: team.location.coordinates[1] }))
      .sort((a, b) => a.teamApiId - b.teamApiId),
    trail: markers.map((marker) => ({
      id: String(marker._id),
      time: marker.time,
      kind: marker.type as ObservationKind,
      lng: marker.location.coordinates[0],
      lat: marker.location.coordinates[1],
    })),
    manualVisits: visits.map((visit) => ({ teamApiId: visit.teamApiId, state: visit.state as ManualVisitFact["state"] })),
  };
}

/** Fingerprint of the inputs: status, groups, every marker and the manual visits. */
export function signatureOf(inputs: AreaInputs): string {
  const parts = [
    inputs.status,
    inputs.round,
    inputs.groups.map((group) => `${group.teamApiId}@${group.lng.toFixed(5)},${group.lat.toFixed(5)}`).join(","),
    inputs.trail.map((point) => `${point.id}@${point.time.toISOString()}`).join(","),
    inputs.manualVisits.map((visit) => `${visit.teamApiId}:${visit.state}`).join(","),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Add walking minutes from the last trail point to every group. */
export async function gatherFacts(inputs: AreaInputs, walk: WalkMinutes, now: Date): Promise<AreaFacts> {
  const last = inputs.trail.at(-1);
  if (!last || inputs.groups.length === 0) {
    return { ...inputs, now, groups: inputs.groups.map((group) => ({ ...group, walkMinutes: 0 })), estimate: false };
  }
  const from: LngLat = [last.lng, last.lat];
  const { minutes, estimate } = await walk(
    from,
    inputs.groups.map((group): LngLat => [group.lng, group.lat]),
  );
  return { ...inputs, now, groups: inputs.groups.map((group, index) => ({ ...group, walkMinutes: minutes[index] })), estimate };
}
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `bun test src/services/prediction/facts.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/prediction/facts.ts src/services/prediction/facts.test.ts
git commit -m "feat: gather area facts for Gemini prediction"
```

---

### Task 4: Prompt and validation

**Files:**
- Create: `SERVER/src/services/prediction/prompt.ts` and `prompt.test.ts`
- Create: `SERVER/src/services/prediction/validate.ts` and `validate.test.ts`

**Interfaces:**
- Consumes: `AreaFacts` (Task 3), `distanceM` (`geo.ts`), and the constants from Task 2.
- Produces:

```ts
// prompt.ts
export function clock(date: Date): string              // "14:05", Europe/Amsterdam
export function buildPrompt(facts: AreaFacts): string
export const PREDICTION_SCHEMA: Record<string, unknown> // Gemini responseSchema
// validate.ts
export type Confidence = "low" | "medium" | "high";
export interface ValidPrediction {
  round: number;
  visitedTeamApiIds: number[];
  pin: { lat: number; lng: number };
  confidence: Confidence;
  candidates: { teamApiId: number; probability: number; etaMinutes: number }[];
  why: string;
}
export class InvalidPredictionError extends Error {}
export function validatePrediction(raw: unknown, facts: AreaFacts): ValidPrediction
```

- [ ] **Step 1: Write the failing tests.**

`prompt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AreaFacts } from "./facts";
import { buildPrompt, clock, PREDICTION_SCHEMA } from "./prompt";

const now = new Date("2026-10-17T12:05:00Z"); // 14:05 in Amsterdam (CEST)
const facts: AreaFacts = {
  area: "alpha",
  status: "green",
  round: 1,
  now,
  estimate: false,
  groups: [{ teamApiId: 7, name: "Scouting Rijn", lng: 5.5, lat: 52.1, walkMinutes: 23 }],
  trail: [{ id: "m1", time: new Date("2026-10-17T11:00:00Z"), kind: "hint", lng: 5.48, lat: 52.08 }],
  manualVisits: [{ teamApiId: 7, state: "not_visited" }],
};

describe("buildPrompt", () => {
  test("clock uses Amsterdam time", () => {
    expect(clock(now)).toBe("14:05");
  });

  test("contains the rules, the local times, minutes ago, walk minutes and manual visits", () => {
    const prompt = buildPrompt(facts);
    expect(prompt).toContain("Jotihunt");
    expect(prompt).toContain("30 minutes");
    expect(prompt).toContain("23:00");
    expect(prompt).toContain('"now":"14:05"');
    expect(prompt).toContain('"time":"13:00"');
    expect(prompt).toContain('"minutesAgo":65');
    expect(prompt).toContain('"walkMinutes":23');
    expect(prompt).toContain('"state":"not_visited"');
    expect(prompt).toContain('"status":"green"');
  });

  test("schema requires every output field", () => {
    expect((PREDICTION_SCHEMA as { required: string[] }).required.sort()).toEqual(
      ["candidates", "confidence", "pin", "reason", "round", "visitedTeamApiIds"].sort(),
    );
  });
});
```

`validate.test.ts`:

```ts
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
  candidates: [
    { teamApiId: 1, probability: 3, etaMinutes: 12.4 },
    { teamApiId: 2, probability: 1, etaMinutes: 30 },
    { teamApiId: 99, probability: 5, etaMinutes: 5 },
    { teamApiId: 4, probability: 5, etaMinutes: 5 },
  ],
  reason: "  Loopt oost langs de dijk.  ",
};

describe("validatePrediction", () => {
  test("manual visits win, unknown and visited ids dropped, probabilities normalised", () => {
    const result = validatePrediction(good, facts);
    expect(result.visitedTeamApiIds).toEqual([4]);
    expect(result.candidates).toEqual([
      { teamApiId: 1, probability: 0.75, etaMinutes: 12 },
      { teamApiId: 2, probability: 0.25, etaMinutes: 30 },
    ]);
    expect(result.why).toBe("Loopt oost langs de dijk.");
    expect(result.confidence).toBe("high");
  });

  test("at most 3 candidates, highest first; zero probabilities split evenly", () => {
    const open = { ...facts, manualVisits: [] };
    const raw = { ...good, visitedTeamApiIds: [], candidates: [1, 2, 3, 4].map((id) => ({ teamApiId: id, probability: 0, etaMinutes: 1 })) };
    const result = validatePrediction(raw, open);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => Math.abs(candidate.probability - 1 / 3) < 1e-9)).toBe(true);
  });

  test("eta clamped to 0..600, why cut at 120 characters, unknown confidence becomes low", () => {
    const raw = { ...good, confidence: "sure", reason: "x".repeat(300), candidates: [{ teamApiId: 1, probability: 1, etaMinutes: -5 }, { teamApiId: 2, probability: 1, etaMinutes: 9999 }] };
    const result = validatePrediction(raw, facts);
    expect(result.candidates.map((candidate) => candidate.etaMinutes)).toEqual([0, 600]);
    expect(result.why).toHaveLength(120);
    expect(result.confidence).toBe("low");
  });

  test("round clamped to current or next", () => {
    expect(validatePrediction({ ...good, round: 5 }, facts).round).toBe(2);
    expect(validatePrediction({ ...good, round: 0 }, facts).round).toBe(1);
    expect(validatePrediction({ ...good, round: "x" }, facts).round).toBe(1);
  });

  test("rejects a pin more than 15 km away or missing", () => {
    expect(() => validatePrediction({ ...good, pin: { lat: 53, lng: 5.48 } }, facts)).toThrow(InvalidPredictionError);
    expect(() => validatePrediction({ ...good, pin: null }, facts)).toThrow(InvalidPredictionError);
  });

  test("rejects no candidates while open groups remain, and non-objects", () => {
    expect(() => validatePrediction({ ...good, candidates: [] }, facts)).toThrow(InvalidPredictionError);
    expect(() => validatePrediction("nope", facts)).toThrow(InvalidPredictionError);
  });

  test("no candidates is fine when every group is visited", () => {
    const allVisited = { ...facts, manualVisits: [1, 2, 3, 4].map((id) => ({ teamApiId: id, state: "visited" as const })) };
    expect(validatePrediction({ ...good, candidates: [] }, allVisited).candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `bun test src/services/prediction/prompt.test.ts src/services/prediction/validate.test.ts`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** `prompt.ts`:

```ts
import type { AreaFacts } from "./facts";

const CLOCK = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "14:05" in Dutch local time. */
export function clock(date: Date): string {
  return CLOCK.format(date);
}

const RULES = `You predict where a fox team is in Jotihunt, a Dutch scouting game.
Rules:
- The fox team (one per area) walks, about 4-5 km/h. Walking minutes to each group are measured along real paths (walkMinutes, from the last trail point).
- The foxes must visit every group of their area once per round, in an order they choose. They usually stay 5-20 minutes at a group.
- A new round starts only after every group was visited. The last group of a round may only be the first of the next round 30 minutes later.
- Status: green = walking, huntable. orange = travelling with a movement budget (car/transit possible, faster than walking). red = inactive.
- At 23:00 the fox teams swap; everyone is inactive 22:45-23:15, and the new team starts near where the old team ended.
- After handing out a counter-hunt code, a fox may not be hunted for 5 minutes.
- The trail: kind "hint" = the solved hourly coordinate (where they were at that time), "hunt" = hunters caught them there, "spot" = hunters saw them there. Newer points are more important.
- manualVisits are confirmed by humans and always correct.

Task:
1. Decide which groups were already visited in the current round (from the trail passing close to them, and manualVisits).
2. Decide the round (the current one, or the next if every group was visited).
3. Estimate where the foxes are right now (pin), taking elapsed time since the last trail point, walking speed and likely stops into account.
4. Rank the 3 most likely next groups with probability (0-1) and etaMinutes = minutes from now until they arrive there.
5. confidence: high when a trail point is recent and the direction is clear, low when the last point is old or ambiguous.
6. reason: one short Dutch sentence, at most 15 words.
Answer only with the JSON object.`;

export const PREDICTION_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    round: { type: "INTEGER" },
    visitedTeamApiIds: { type: "ARRAY", items: { type: "INTEGER" } },
    pin: { type: "OBJECT", properties: { lat: { type: "NUMBER" }, lng: { type: "NUMBER" } }, required: ["lat", "lng"] },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { teamApiId: { type: "INTEGER" }, probability: { type: "NUMBER" }, etaMinutes: { type: "INTEGER" } },
        required: ["teamApiId", "probability", "etaMinutes"],
      },
    },
    reason: { type: "STRING" },
  },
  required: ["round", "visitedTeamApiIds", "pin", "confidence", "candidates", "reason"],
};

export function buildPrompt(facts: AreaFacts): string {
  const data = {
    area: facts.area,
    status: facts.status,
    now: clock(facts.now),
    round: facts.round,
    trail: facts.trail.map((point) => ({
      time: clock(point.time),
      minutesAgo: Math.round((facts.now.getTime() - point.time.getTime()) / 60_000),
      kind: point.kind,
      lat: point.lat,
      lng: point.lng,
    })),
    groups: facts.groups.map((group) => ({ teamApiId: group.teamApiId, name: group.name, lat: group.lat, lng: group.lng, walkMinutes: group.walkMinutes })),
    manualVisits: facts.manualVisits,
  };
  return `${RULES}\n\nFacts:\n${JSON.stringify(data)}`;
}
```

- [ ] **Step 4: Implement** `validate.ts`:

```ts
import { MAX_ETA_MINUTES, MAX_PIN_DISTANCE_M, MAX_WHY_LENGTH, TOP_CANDIDATES } from "./constants";
import type { AreaFacts } from "./facts";
import { distanceM } from "./geo";

export type Confidence = "low" | "medium" | "high";

export interface ValidPrediction {
  round: number;
  visitedTeamApiIds: number[];
  pin: { lat: number; lng: number };
  confidence: Confidence;
  candidates: { teamApiId: number; probability: number; etaMinutes: number }[];
  why: string;
}

export class InvalidPredictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPredictionError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Turn Gemini's raw JSON into a safe prediction, or throw InvalidPredictionError. */
export function validatePrediction(raw: unknown, facts: AreaFacts): ValidPrediction {
  if (!isRecord(raw)) throw new InvalidPredictionError("Antwoord is geen object");
  const known = new Set(facts.groups.map((group) => group.teamApiId));

  const manualVisited = facts.manualVisits.filter((visit) => visit.state === "visited").map((visit) => visit.teamApiId);
  const manualNot = new Set(facts.manualVisits.filter((visit) => visit.state === "not_visited").map((visit) => visit.teamApiId));
  const aiVisited = Array.isArray(raw.visitedTeamApiIds) ? raw.visitedTeamApiIds.filter(finite) : [];
  const visited = [...new Set([...aiVisited, ...manualVisited])].filter((id) => known.has(id) && !manualNot.has(id)).sort((a, b) => a - b);
  const visitedSet = new Set(visited);

  const seen = new Set<number>();
  const picked = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .filter(isRecord)
    .filter((candidate) => finite(candidate.teamApiId) && known.has(candidate.teamApiId) && !visitedSet.has(candidate.teamApiId))
    .filter((candidate) => !seen.has(candidate.teamApiId as number) && seen.add(candidate.teamApiId as number))
    .map((candidate) => ({
      teamApiId: candidate.teamApiId as number,
      probability: finite(candidate.probability) ? Math.max(0, candidate.probability) : 0,
      etaMinutes: Math.min(MAX_ETA_MINUTES, Math.max(0, Math.round(finite(candidate.etaMinutes) ? candidate.etaMinutes : 0))),
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, TOP_CANDIDATES);
  const openGroups = facts.groups.length - visited.length;
  if (picked.length === 0 && openGroups > 0) throw new InvalidPredictionError("Geen geldige kandidaten");
  const total = picked.reduce((sum, candidate) => sum + candidate.probability, 0);
  const candidates = picked.map((candidate) => ({ ...candidate, probability: total > 0 ? candidate.probability / total : 1 / picked.length }));

  const pin = raw.pin;
  if (!isRecord(pin) || !finite(pin.lat) || !finite(pin.lng)) throw new InvalidPredictionError("Geen geldige pin");
  const last = facts.trail.at(-1);
  if (last && distanceM([last.lng, last.lat], [pin.lng, pin.lat]) > MAX_PIN_DISTANCE_M) throw new InvalidPredictionError("Pin te ver van laatste locatie");

  const round = finite(raw.round) ? Math.min(facts.round + 1, Math.max(facts.round, Math.round(raw.round))) : facts.round;
  const confidence: Confidence = raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low";
  const why = (typeof raw.reason === "string" ? raw.reason.trim() : "").slice(0, MAX_WHY_LENGTH);

  return { round, visitedTeamApiIds: visited, pin: { lat: pin.lat, lng: pin.lng }, confidence, candidates, why };
}
```

- [ ] **Step 5: Run the tests and confirm they pass.** Run `bun test src/services/prediction/prompt.test.ts src/services/prediction/validate.test.ts`. Expected: PASS. If the Node ICU build prints "14:05" with a different separator, adjust nothing: `hourCycle: "h23"` with `nl-NL` gives "14:05".

- [ ] **Step 6: Commit.**

```bash
git add src/services/prediction/{prompt,validate}{.ts,.test.ts}
git commit -m "feat: Gemini prediction prompt, schema and output validation"
```

---

### Task 5: Gemini predictor

**Files:**
- Create: `SERVER/src/services/prediction/gemini-predictor.ts` and `gemini-predictor.test.ts`

**Interfaces:**
- Consumes: `generateJson`, `GeminiHttp` and `GeminiError` (Task 1), and `PREDICTION_SCHEMA` (Task 4).
- Produces:

```ts
export const DEFAULT_PREDICTION_MODEL = "gemini-pro-latest";
export interface FoxPredictor { predict(prompt: string): Promise<unknown> }
export function createGeminiPredictor(options: { apiKey: string; model: string; http: GeminiHttp }): FoxPredictor
```

`predict` returns the parsed JSON. It throws `GeminiError` (with `retryable=false`) when the JSON is invalid.

- [ ] **Step 1: Write the failing test** `gemini-predictor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GeminiError, type GeminiHttp } from "../gemini.client";
import { createGeminiPredictor, DEFAULT_PREDICTION_MODEL } from "./gemini-predictor";
import { PREDICTION_SCHEMA } from "./prompt";

const KEY = "secret-key-9";

function http(respond: () => Promise<{ data: unknown }>) {
  const calls: { url: string; body: any; config: any }[] = [];
  const client: GeminiHttp = {
    post: async <T>(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => {
      calls.push({ url, body, config });
      return (await respond()) as { data: T };
    },
  };
  return { client, calls };
}
const reply = (text: string) => async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });

describe("createGeminiPredictor", () => {
  test("default model is gemini-pro-latest", () => {
    expect(DEFAULT_PREDICTION_MODEL).toBe("gemini-pro-latest");
  });

  test("sends prompt, schema, temperature 0.2 and a 90 s timeout; parses JSON", async () => {
    const { client, calls } = http(reply('{"round":1}'));
    const predictor = createGeminiPredictor({ apiKey: KEY, model: "gemini-pro-latest", http: client });
    expect(await predictor.predict("PROMPT")).toEqual({ round: 1 });
    expect(calls[0].url).toContain("/models/gemini-pro-latest:generateContent");
    expect(calls[0].body.contents[0].parts).toEqual([{ text: "PROMPT" }]);
    expect(calls[0].body.generationConfig).toEqual({ responseMimeType: "application/json", responseSchema: PREDICTION_SCHEMA, temperature: 0.2 });
    expect(calls[0].config.timeout).toBe(90_000);
  });

  test("invalid JSON is a non-retryable GeminiError without the key", async () => {
    const { client } = http(reply("not json"));
    const predictor = createGeminiPredictor({ apiKey: KEY, model: "m", http: client });
    const error = await predictor.predict("P").catch((caught) => caught);
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(KEY);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails.** Run `bun test src/services/prediction/gemini-predictor.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `gemini-predictor.ts`:

```ts
import { GeminiError, generateJson, type GeminiHttp } from "../gemini.client";
import { PREDICTION_SCHEMA } from "./prompt";

export const DEFAULT_PREDICTION_MODEL = "gemini-pro-latest";
const TIMEOUT_MS = 90_000;

export interface FoxPredictor {
  /** Parsed JSON answer (not yet validated). Throws GeminiError. */
  predict(prompt: string): Promise<unknown>;
}

export function createGeminiPredictor({ apiKey, model, http }: { apiKey: string; model: string; http: GeminiHttp }): FoxPredictor {
  return {
    async predict(prompt) {
      const text = await generateJson({
        http,
        apiKey,
        model,
        parts: [{ text: prompt }],
        generationConfig: { responseSchema: PREDICTION_SCHEMA, temperature: 0.2 },
        timeoutMs: TIMEOUT_MS,
      });
      try {
        return JSON.parse(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `bun test src/services/prediction/gemini-predictor.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/prediction/gemini-predictor.ts src/services/prediction/gemini-predictor.test.ts
git commit -m "feat: Gemini fox predictor client"
```

---

### Task 6: Prediction service, model, visits, wiring and old-code removal

**Files:**
- Rewrite: `SERVER/src/models/prediction.model.ts`
- Rewrite: `SERVER/src/services/prediction/prediction.service.ts` and `prediction.service.test.ts`
- Rewrite: `SERVER/src/services/prediction/visit.service.ts` and `visit.service.test.ts`
- Rewrite: `SERVER/src/services/prediction/instance.ts`, `SERVER/src/crons/prediction.cron.ts`, `SERVER/src/controllers/predictions.controller.ts`
- Modify: `SERVER/src/routes/admin.route.ts:75` (delete the line), `SERVER/src/index.ts`, `SERVER/src/scripts/seed-prediction.ts`, `SERVER/src/demo/demo-world.ts`, `SERVER/src/demo/generator/generate-world.ts`, `SERVER/.env.example`, `/home/silke/Documents/Jotihunt 2026/.env.example`
- Delete: `SERVER/src/models/prediction-model.model.ts`, `SERVER/src/models/transit-stop.model.ts`, and in `SERVER/src/services/prediction/`: `scoring.ts`, `scoring.test.ts`, `tour.ts`, `tour.test.ts`, `learning.ts`, `learning.test.ts`, `zones.ts`, `zones.test.ts`, `transit.ts`, `transit.test.ts`, `transitous.client.ts`, `transitous.client.test.ts`, `overpass.client.ts`, `overpass.client.test.ts`, `transit-stop.service.ts`, `transit-stop.service.test.ts`, `visits.ts`, `visits.test.ts`, `replay.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `createPredictionService(deps: { predictor: FoxPredictor | null; walkMinutes: WalkMinutes; now?: () => Date }): { recomputeArea(area: string): Promise<PredictionDto>; recomputeDue(): Promise<{ recomputed: string[]; failed: { area: string; error: unknown }[] }> }`
  - `listPredictions()`
  - `listCurrentVisits(): Promise<VisitDto[]>`
  - `setManualVisit(teamApiId, state, now?)`
  - `PredictionDto`, as shown below.

- [ ] **Step 1: Replace** `src/models/prediction.model.ts`:

```ts
import mongoose from "mongoose";

// The latest Gemini prediction per area, so GET /predictions is a plain read.
const PredictionSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, default: "unknown" },
    paused: { type: Boolean, default: false },
    reason: { type: String },
    updatedAt: { type: Date, required: true },
    round: { type: Number, default: 1 },
    /** Walk minutes were straight-line estimates */
    estimate: { type: Boolean, default: false },
    /** The last Gemini run failed; the fields below are from an older run */
    stale: { type: Boolean, default: false },
    error: { type: String },
    lastObservation: { type: mongoose.Schema.Types.Mixed, default: null },
    pin: { type: mongoose.Schema.Types.Mixed, default: null },
    confidence: { type: String, enum: ["low", "medium", "high"], default: null },
    candidates: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    visitedTeamApiIds: { type: [Number], default: () => [] },
    why: { type: String, default: "" },
    // Not exposed by the API: inputs fingerprint and the time of the last (possibly failed) attempt
    signature: { type: String, default: "" },
    attemptedAt: { type: Date },
  },
  { minimize: false },
);

export const Prediction = mongoose.model("Prediction", PredictionSchema);
```

- [ ] **Step 2: Write the failing service test.** Replace `prediction.service.test.ts` with:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit } from "../../models/group-visit.model";
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
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: "visited", source: "manual" });
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
```

- [ ] **Step 3: Run the test and confirm it fails.** Run `bun test src/services/prediction/prediction.service.test.ts`. Expected: FAIL, from imports or signature mismatches.

- [ ] **Step 4: Replace** `prediction.service.ts`:

```ts
import { Prediction } from "../../models/prediction.model";
import { assertGeneration, currentGeneration, DemoSwitchedError, isDemoSwitchInProgress } from "../../demo/demo-mode";
import { GeminiError } from "../gemini.client";
import { FAILURE_BACKOFF_MS, RECOMPUTE_INTERVAL_MS } from "./constants";
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
  let queue: Promise<unknown> = Promise.resolve();

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
      if (first instanceof GeminiError && !first.retryable && first.status !== undefined) throw first;
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
      const kept = (previous as PredictionDto | null) ?? dto;
      assertGeneration(generation);
      // Keep the old signature so the next tick still sees the new inputs as changed
      await Prediction.updateOne(
        { area: inputs.area },
        { $set: { ...kept, status: inputs.status, stale: true, error: errorMessage(error), attemptedAt: at }, $setOnInsert: { signature: "" } },
        { upsert: true },
      );
      return { ...kept, status: inputs.status, stale: true, error: errorMessage(error) };
    }
  }

  /** Recompute one area now (e.g. after a manual visit change). */
  function recomputeArea(area: string): Promise<PredictionDto> {
    const name = area.toLowerCase();
    const generation = currentGeneration();
    return serial(async () => compute(await loadAreaInputs(name), generation));
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
```

Note on `askGemini`: a retryable error, invalid JSON (non-retryable without a status) or an `InvalidPredictionError` gets one retry. A non-retryable HTTP error (for example 400 or 403) fails immediately.

- [ ] **Step 5: Replace** `visit.service.ts`. Manual overrides are stored; AI visits come from the prediction.

```ts
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";

export type VisitInput = "visited" | "not_visited" | "auto";

export interface VisitDto {
  area: string;
  teamApiId: number;
  round: number;
  state: "visited" | "not_visited";
  /** auto = decided by the AI prediction */
  source: "auto" | "manual";
  visitedAt: Date | null;
}

async function currentRoundFor(area: string): Promise<number> {
  return (await Prediction.findOne({ area }, { round: 1 }).lean())?.round ?? 1;
}

/**
 * Set or clear a manual override for a group in the area's current round.
 * @returns null when the team is unknown or has no area
 */
export async function setManualVisit(teamApiId: number, state: VisitInput, now = new Date()): Promise<{ area: string; visit: VisitDto } | null> {
  const team = await Team.findOne({ apiId: teamApiId }).lean();
  if (!team?.area) return null;
  const area = team.area.toLowerCase();
  const round = await currentRoundFor(area);

  if (state === "auto") {
    await GroupVisit.deleteOne({ teamApiId, round, source: VisitSource.Manual });
    const prediction = await Prediction.findOne({ area }, { visitedTeamApiIds: 1 }).lean();
    const visited = (prediction?.visitedTeamApiIds ?? []).includes(teamApiId);
    return { area, visit: { area, teamApiId, round, state: visited ? "visited" : "not_visited", source: "auto", visitedAt: null } };
  }

  const doc = await GroupVisit.findOneAndUpdate(
    { teamApiId, round },
    { $set: { area, state, source: VisitSource.Manual, visitedAt: state === VisitState.Visited ? now : null, evidence: "manual" } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  return { area, visit: { area, teamApiId, round, state, source: "manual", visitedAt: doc?.visitedAt ?? null } };
}

/** Current-round visits: manual overrides plus the groups the AI marked as visited. */
export async function listCurrentVisits(): Promise<VisitDto[]> {
  const [predictions, manual] = await Promise.all([
    Prediction.find({}, { area: 1, round: 1, visitedTeamApiIds: 1 }).lean(),
    GroupVisit.find({ source: VisitSource.Manual }).sort({ teamApiId: 1 }).lean(),
  ]);
  const roundByArea = new Map(predictions.map((prediction) => [prediction.area, prediction.round ?? 1]));
  const visits: VisitDto[] = manual
    .filter((doc) => doc.round === (roundByArea.get(doc.area) ?? 1))
    .map((doc) => ({ area: doc.area, teamApiId: doc.teamApiId, round: doc.round, state: doc.state as VisitDto["state"], source: "manual", visitedAt: doc.visitedAt ?? null }));
  const overridden = new Set(visits.map((visit) => visit.teamApiId));
  for (const prediction of predictions) {
    for (const teamApiId of prediction.visitedTeamApiIds ?? []) {
      if (!overridden.has(teamApiId)) visits.push({ area: prediction.area, teamApiId, round: prediction.round ?? 1, state: "visited", source: "auto", visitedAt: null });
    }
  }
  return visits.sort((a, b) => a.teamApiId - b.teamApiId);
}
```

Replace `visit.service.test.ts` with:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import { listCurrentVisits, setManualVisit } from "./visit.service";

const O: [number, number] = [5.48, 52.08];
beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("visits", () => {
  test("AI visits listed as auto; manual override wins", async () => {
    await makeTeam(1, "alpha", O);
    await makeTeam(2, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 1, visitedTeamApiIds: [1, 2] });
    await setManualVisit(2, "not_visited");
    const visits = await listCurrentVisits();
    expect(visits.map((visit) => [visit.teamApiId, visit.state, visit.source])).toEqual([
      [1, "visited", "auto"],
      [2, "not_visited", "manual"],
    ]);
  });

  test("auto removes the manual override and reports the AI state", async () => {
    await makeTeam(1, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 1, visitedTeamApiIds: [1] });
    await setManualVisit(1, "not_visited");
    const result = await setManualVisit(1, "auto");
    expect(result?.visit).toMatchObject({ state: "visited", source: "auto" });
    expect(await GroupVisit.countDocuments()).toBe(0);
  });

  test("manual visits of another round are not listed; unknown team is null", async () => {
    await makeTeam(1, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 2 });
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: "visited", source: "manual" });
    expect(await listCurrentVisits()).toEqual([]);
    expect(await setManualVisit(999, "visited")).toBeNull();
  });
});
```

- [ ] **Step 6: Replace** `instance.ts`:

```ts
import axios from "axios";
import { createGeminiPredictor, DEFAULT_PREDICTION_MODEL } from "./gemini-predictor";
import { createOrsRouter } from "./ors.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createWalkMinutes } from "./walking";

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  predictor: geminiApiKey
    ? createGeminiPredictor({ apiKey: geminiApiKey, model: process.env.GEMINI_PREDICTION_MODEL?.trim() || DEFAULT_PREDICTION_MODEL, http: axios.create() })
    : null,
  walkMinutes: createWalkMinutes({ walking: createOrsRouter(process.env.ORS_API_KEY || undefined), fallback: straightLineRouter }),
});
```

- [ ] **Step 7: Replace** `src/crons/prediction.cron.ts`:

```ts
import { logger } from "..";
import { runTracked } from "../demo/database-switch";
import { predictionService } from "../services/prediction/instance";

async function recompute() {
  const { recomputed, failed } = await predictionService.recomputeDue();
  if (recomputed.length > 0) logger.info(`(CRON) Recomputed fox predictions for ${recomputed.join(", ")}`);
  for (const failure of failed) logger.error(`(CRON) Fox prediction for ${failure.area} failed`, failure.error);
}

/** Tracked, so a demo switch waits for it (and it is skipped while a switch runs). */
export default async function recomputePredictions() {
  await runTracked(recompute);
}
```

- [ ] **Step 8: Replace** `src/controllers/predictions.controller.ts`:

```ts
import { Request, Response } from "express";
import { logger } from "..";
import { predictionService } from "../services/prediction/instance";
import { listPredictions } from "../services/prediction/prediction.service";
import { listCurrentVisits, setManualVisit, type VisitInput } from "../services/prediction/visit.service";

export async function getPredictions(_req: Request, res: Response) {
  return res.status(200).json(await listPredictions());
}

export async function getVisits(_req: Request, res: Response) {
  return res.status(200).json(await listCurrentVisits());
}

export async function putVisit(req: Request, res: Response) {
  const teamApiId = Number(req.params.teamApiId);
  const result = await setManualVisit(teamApiId, req.body.state as VisitInput);
  if (!result) return res.status(404).json({ message: "Groep niet gevonden of niet gekoppeld aan een deelgebied." });
  // Recompute in the background so the response stays fast (Gemini can take tens of seconds)
  predictionService.recomputeArea(result.area).catch((error) => logger.error(`Recomputing prediction for ${result.area} failed`, error));
  return res.status(200).json(result.visit);
}
```

- [ ] **Step 9: Wiring and cleanup.**
  - `src/routes/admin.route.ts`: delete line 75 (`router.post("/transit-stops/refresh", ...)`). If `predictionsController` is now unused in that file, delete its import.
  - `src/index.ts`:
    - Replace the comment at line 168 with `// Fox prediction (Gemini): recompute changed areas every minute (and every area at least every 10 minutes)`.
    - Change the GEMINI warning at line 125 to `"GEMINI_API_KEY not set, hunt photos are not read and fox predictions are off"`.
    - Change the ORS warning at line 171 to `"ORS_API_KEY not set, fox prediction uses straight-line walking times"`.
  - `src/demo/demo-world.ts`: remove the `transitStops: () => readRealCollection("transitstops"),` line and fix the doc comment ("Teams are copied…").
  - `src/demo/generator/generate-world.ts`:
    - Remove the `TransitStop` import (line 11) and the `transitStops()` member plus its comment (lines 39–40).
    - Remove lines 145–146 (`const stops = …` / `insertMany(stops…)`).
    - Update the comments at lines 132 and 140 to mention only teams.
  - Run `grep -rn "transitStops" src` and remove the remaining `transitStops:` entries in the test sources.
  - Delete the files listed under "Delete" at the top of this task: `git rm src/models/prediction-model.model.ts src/models/transit-stop.model.ts src/services/prediction/{scoring,tour,learning,zones,transit,transitous.client,overpass.client,transit-stop.service,visits}.ts src/services/prediction/{scoring,tour,learning,zones,transit,transitous.client,overpass.client,transit-stop.service,visits,replay}.test.ts`.
  - `src/scripts/seed-prediction.ts`:
    - Remove the imports of `PredictionModel`, `TransitStop`, `stopSource` and `refreshTransitStops`, so the instance import becomes `import { predictionService } from "../services/prediction/instance";`.
    - In `--clean`, replace the `Promise.all` line with `await Promise.all([Prediction.deleteMany({}), RoutingCache.deleteMany({})]);` and change the log to `"Removed seeded fox prediction data (teams, markers, visits, predictions, routing cache)"`.
    - Delete the `try { console.log(\`Transit stops stored…` block.
    - Replace the output loop with:

```ts
for (const area of ["alpha", "oscar"]) {
  const prediction = await predictionService.recomputeArea(area);
  console.log(`${area}: confidence=${prediction.confidence} stale=${prediction.stale} round=${prediction.round} ${prediction.reason ?? prediction.why}`);
  for (const candidate of prediction.candidates) {
    console.log(`  ${candidate.name}: ${Math.round(candidate.probability * 100)}%, eta ${candidate.eta.toISOString()} (${candidate.walkMinutes} min lopen)`);
  }
}
```

  - Add `GEMINI_PREDICTION_MODEL=gemini-pro-latest` after the `GEMINI_MODEL` line in both `SERVER/.env.example` and `/home/silke/Documents/Jotihunt 2026/.env.example`. If `/home/silke/Documents/Jotihunt 2026/docker-compose.yml` passes `GEMINI_*` variables explicitly, add it there too; if it uses `env_file`, do nothing.
  - Search for leftovers: `grep -rn "isochrones\|TransitStop\|PredictionModel\|transitUnavailable\|replaceAutoVisits\|manualVisitsVersion\|\"./visits\"\|zones\"" src`. Expected: no hits.

- [ ] **Step 10: Run the full check.** Run `cd SERVER && bunx tsc --noEmit && bun test`. Expected: no type errors, and every test PASSes. Fix any leftovers the compiler reports: for example, `rd-answer.test.ts` and the demo tests import `geo`/`types` (`LngLat` is still exported, so they should compile).

- [ ] **Step 11: Commit.**

```bash
git add -A src .env.example
git commit -m "feat: Gemini-only fox prediction; remove heuristic, transit and learning"
```

Commit the root `.env.example` separately only if the root folder is a git repo (it is not at the time of writing; skip otherwise).

---

### Task 7: Client types and prediction helpers

**Files (CLIENT):**
- Modify: `src/types/Prediction.ts`, `src/lib/prediction.ts`, `src/lib/prediction.test.ts`, `src/lib/hunt-reports.ts` (`nearestArea`), and its test if it builds `Prediction` fixtures.
- Modify: `src/components/map/VisitControls.tsx` (the "Automatisch" label becomes "AI").

**Interfaces:**
- Produces (used by Tasks 8 and 9):

```ts
// types/Prediction.ts
export type Confidence = 'low' | 'medium' | 'high';
export interface PredictionCandidate { teamApiId: number; name: string; lng: number; lat: number; probability: number; eta: string; walkMinutes: number }
export interface Prediction { area: string; status: string; paused: boolean; reason?: string; updatedAt: string; round: number; estimate: boolean; stale: boolean; error?: string;
  lastObservation: { time: string; lng: number; lat: number; kind: 'hint' | 'hunt' | 'spot' } | null;
  pin: { lat: number; lng: number } | null; confidence: Confidence | null; candidates: PredictionCandidate[]; visitedTeamApiIds: number[]; why: string }
// lib/prediction.ts
formatClock(iso): string; formatProbability(p): string; badgeText(c): string /* "62% 14:20" */;
ageLabel(updatedAt: string, nowMs: number): string /* "nu" | "4m" | "2u" */;
CONFIDENCE_COLOR: Record<Confidence, string>; CONFIDENCE_LABEL: Record<Confidence, string>;
predictionStatusText(p): string | null; predictionSummary(ps?): string | undefined;
visitSelection(v?): VisitChoice; visitStatusText(v?): string;
buildPredictionMap(predictions, colorFor): { lines: FeatureCollection<LineString, { area: string; color: string }>; pins: MapPin[]; badges: MapBadge[] }
interface MapPin { area: string; lng: number; lat: number; color: string; stale: boolean }
interface MapBadge { key: string; area: string; lng: number; lat: number; color: string; text: string; rank: number }
```

- [ ] **Step 1: Replace** `src/types/Prediction.ts`:

```ts
export type Confidence = 'low' | 'medium' | 'high';

export interface PredictionCandidate {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
  /** 0–1 */
  probability: number;
  /** ISO time */
  eta: string;
  walkMinutes: number;
}

export interface Prediction {
  area: string;
  status: string;
  paused: boolean;
  reason?: string;
  updatedAt: string;
  round: number;
  /** Walking times were straight-line estimates */
  estimate: boolean;
  /** The last AI run failed; this is an older prediction */
  stale: boolean;
  error?: string;
  lastObservation: { time: string; lng: number; lat: number; kind: 'hint' | 'hunt' | 'spot' } | null;
  /** AI best guess of the current fox position */
  pin: { lat: number; lng: number } | null;
  confidence: Confidence | null;
  candidates: PredictionCandidate[];
  visitedTeamApiIds: number[];
  /** One short Dutch sentence, shown behind ⓘ */
  why: string;
}

export type VisitState = 'visited' | 'not_visited';
export type VisitChoice = VisitState | 'auto';

export interface GroupVisit {
  area: string;
  teamApiId: number;
  round: number;
  state: VisitState;
  /** auto = decided by the AI */
  source: 'auto' | 'manual';
  visitedAt: string | null;
}
```

- [ ] **Step 2: Write the failing test.** Replace `src/lib/prediction.test.ts` with:

```ts
import { describe, expect, test } from 'bun:test';
import type { Prediction } from '@/types/Prediction';
import { ageLabel, badgeText, buildPredictionMap, formatProbability, predictionStatusText, predictionSummary, visitSelection, visitStatusText } from './prediction';

function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    area: 'alpha',
    status: 'green',
    paused: false,
    updatedAt: '2026-10-17T12:00:00Z',
    round: 1,
    estimate: false,
    stale: false,
    lastObservation: { time: '2026-10-17T11:00:00Z', lng: 5.48, lat: 52.08, kind: 'hint' },
    pin: { lat: 52.09, lng: 5.5 },
    confidence: 'high',
    candidates: [
      { teamApiId: 1, name: 'Rijn', lng: 5.51, lat: 52.1, probability: 0.62, eta: '2026-10-17T12:20:00Z', walkMinutes: 20 },
      { teamApiId: 2, name: 'Valken', lng: 5.52, lat: 52.1, probability: 0.38, eta: '2026-10-17T12:35:00Z', walkMinutes: 35 },
    ],
    visitedTeamApiIds: [],
    why: 'Richting oost.',
    ...overrides,
  };
}

describe('prediction helpers', () => {
  test('formatProbability extremes', () => {
    expect(formatProbability(0.999)).toBe('>99%');
    expect(formatProbability(0.001)).toBe('<1%');
    expect(formatProbability(0.62)).toBe('62%');
  });

  test('badgeText is "62% HH:mm"', () => {
    expect(badgeText(prediction().candidates[0])).toMatch(/^62% \d{2}:\d{2}$/);
  });

  test('ageLabel', () => {
    const t = Date.parse('2026-10-17T12:00:00Z');
    expect(ageLabel('2026-10-17T12:00:00Z', t + 30_000)).toBe('nu');
    expect(ageLabel('2026-10-17T12:00:00Z', t + 4 * 60_000)).toBe('4m');
    expect(ageLabel('2026-10-17T12:00:00Z', t + 125 * 60_000)).toBe('2u');
  });

  test('status text', () => {
    expect(predictionStatusText(prediction())).toBeNull();
    expect(predictionStatusText(prediction({ paused: true, reason: 'Inactief' }))).toBe('Inactief');
    expect(predictionStatusText(prediction({ pin: null, candidates: [], reason: 'Nog geen locatie' }))).toBe('Nog geen locatie');
    expect(predictionStatusText(prediction({ candidates: [] }))).toBe('Alle groepen bezocht');
  });

  test('summary counts predictions with a pin', () => {
    expect(predictionSummary([prediction(), prediction({ area: 'b', pin: null })])).toBe('1 actief');
    expect(predictionSummary([prediction({ paused: true })])).toBe('Geen actieve');
  });

  test('visit helpers', () => {
    expect(visitSelection(undefined)).toBe('auto');
    expect(visitSelection({ area: 'a', teamApiId: 1, round: 1, state: 'visited', source: 'manual', visitedAt: null })).toBe('visited');
    expect(visitStatusText(undefined)).toBe('Nog niet bezocht (AI)');
    expect(visitStatusText({ area: 'a', teamApiId: 1, round: 2, state: 'visited', source: 'auto', visitedAt: null })).toBe('Bezocht (AI) · ronde 2');
  });

  test('buildPredictionMap: line last→pin, pin, badges ranked; paused and pinless skipped', () => {
    const map = buildPredictionMap([prediction(), prediction({ area: 'b', paused: true }), prediction({ area: 'c', pin: null })], () => '#f00');
    expect(map.pins).toEqual([{ area: 'alpha', lng: 5.5, lat: 52.09, color: '#f00', stale: false }]);
    expect(map.lines.features).toHaveLength(1);
    expect(map.lines.features[0].geometry.coordinates).toEqual([
      [5.48, 52.08],
      [5.5, 52.09],
    ]);
    expect(map.badges.map((badge) => [badge.key, badge.rank])).toEqual([
      ['alpha-1', 0],
      ['alpha-2', 1],
    ]);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails.** Run `cd CLIENT && bun test src/lib/prediction.test.ts`. Expected: FAIL (missing exports).

- [ ] **Step 4: Replace** `src/lib/prediction.ts`:

```ts
import { format } from 'date-fns';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { Confidence, GroupVisit, Prediction, PredictionCandidate, VisitChoice } from '@/types/Prediction';

export interface MapPin {
  area: string;
  lng: number;
  lat: number;
  color: string;
  stale: boolean;
}

export interface MapBadge {
  key: string;
  area: string;
  lng: number;
  lat: number;
  color: string;
  text: string;
  /** 0 = most likely */
  rank: number;
}

export const CONFIDENCE_COLOR: Record<Confidence, string> = { high: 'bg-green-500', medium: 'bg-amber-500', low: 'bg-red-500' };
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: 'Zekerheid hoog', medium: 'Zekerheid middel', low: 'Zekerheid laag' };

/** 24h local clock time, e.g. "14:20". */
export function formatClock(iso: string): string {
  return format(new Date(iso), 'HH:mm');
}

/** Rounded percentage that never claims certainty: ">99%" and "<1%" at the extremes. */
export function formatProbability(probability: number): string {
  if (probability >= 0.995) return '>99%';
  if (probability < 0.005) return '<1%';
  return `${Math.round(probability * 100)}%`;
}

/** "62% 14:20" */
export function badgeText(candidate: PredictionCandidate): string {
  return `${formatProbability(candidate.probability)} ${formatClock(candidate.eta)}`;
}

/** Compact age: "nu", "4m", "2u". */
export function ageLabel(updatedAt: string, nowMs: number): string {
  const minutes = Math.floor((nowMs - new Date(updatedAt).getTime()) / 60_000);
  if (minutes < 1) return 'nu';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}u`;
}

/** Text to show instead of the candidate bars, or null for an active prediction. */
export function predictionStatusText(prediction: Prediction): string | null {
  if (prediction.paused) return prediction.reason ?? 'Gepauzeerd';
  if (prediction.reason) return prediction.reason;
  if (prediction.candidates.length === 0) return 'Alle groepen bezocht';
  return null;
}

/** Collapsed sidebar summary: number of predictions with a pin. */
export function predictionSummary(predictions?: Prediction[]): string | undefined {
  if (!predictions) return undefined;
  const active = predictions.filter((prediction) => !prediction.paused && prediction.pin).length;
  return active === 0 ? 'Geen actieve' : `${active} actief`;
}

/** Which of the three visit buttons is active: a manual state, or AI. */
export function visitSelection(visit?: GroupVisit): VisitChoice {
  return visit?.source === 'manual' ? visit.state : 'auto';
}

export function visitStatusText(visit?: GroupVisit): string {
  if (!visit) return 'Nog niet bezocht (AI)';
  const state = visit.state === 'visited' ? 'Bezocht' : 'Niet bezocht';
  const source = visit.source === 'manual' ? 'handmatig' : 'AI';
  const time = visit.source === 'manual' && visit.state === 'visited' && visit.visitedAt ? `, ${formatClock(visit.visitedAt)}` : '';
  return `${state} (${source}${time}) · ronde ${visit.round}`;
}

/** Map data: a dashed line from the last observation to the pin, the pins, and a badge per candidate group. */
export function buildPredictionMap(
  predictions: Prediction[],
  colorFor: (area: string) => string,
): { lines: FeatureCollection<LineString, { area: string; color: string }>; pins: MapPin[]; badges: MapBadge[] } {
  const lines: Feature<LineString, { area: string; color: string }>[] = [];
  const pins: MapPin[] = [];
  const badges: MapBadge[] = [];
  for (const prediction of predictions) {
    if (prediction.paused || !prediction.pin) continue;
    const color = colorFor(prediction.area);
    const { pin, lastObservation: last } = prediction;
    pins.push({ area: prediction.area, lng: pin.lng, lat: pin.lat, color, stale: prediction.stale });
    if (last) {
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[last.lng, last.lat], [pin.lng, pin.lat]] },
        properties: { area: prediction.area, color },
      });
    }
    prediction.candidates.forEach((candidate, rank) => {
      badges.push({ key: `${prediction.area}-${candidate.teamApiId}`, area: prediction.area, lng: candidate.lng, lat: candidate.lat, color, text: badgeText(candidate), rank });
    });
  }
  return { lines: { type: 'FeatureCollection', features: lines }, pins, badges };
}
```

- [ ] **Step 5: Update `nearestArea`** in `src/lib/hunt-reports.ts`. Use the pin first, then the last observation:

```ts
export function nearestArea(position: { lng: number; lat: number } | null, predictions: Prediction[] | undefined): string | null {
  if (!position || !predictions) return null;
  let best: { area: string; km: number } | null = null;
  for (const prediction of predictions) {
    const point = prediction.pin ?? prediction.lastObservation;
    if (!point) continue;
    const km = distance([position.lng, position.lat], [point.lng, point.lat]);
    if (!best || km < best.km) best = { area: prediction.area, km };
  }
  return best?.area ?? null;
}
```

In `src/lib/hunt-reports.test.ts`, update any `Prediction` fixture to the new shape: remove `mode`, `transitUnavailable`, `zone` and `accuracy`, and add `stale: false, pin: null, confidence: null, visitedTeamApiIds: [], why: ''`. Use `grep -n "zone\|accuracy" src/lib/hunt-reports.test.ts` to find them.

- [ ] **Step 6: VisitControls label.** In `src/components/map/VisitControls.tsx`, change `{ value: 'auto', label: 'Automatisch' }` to `{ value: 'auto', label: 'AI' }` and the doc comment to `/** Visited / not visited / AI buttons for a group (used in the group popup). */`.

- [ ] **Step 7: Run the tests and confirm they pass.** Run `bun test src/lib`. Expected: PASS. Components still reference old helpers until Tasks 8 and 9, so skip `tsc` for now.

- [ ] **Step 8: Commit.**

```bash
git add src/types/Prediction.ts src/lib/prediction.ts src/lib/prediction.test.ts src/lib/hunt-reports.ts src/lib/hunt-reports.test.ts src/components/map/VisitControls.tsx
git commit -m "feat: client types and helpers for Gemini prediction"
```

---

### Task 8: Sidebar prediction cards

**Files (CLIENT):**
- Rewrite: `src/components/sidebar/PredictionList.tsx`

**Interfaces:**
- Consumes: `ageLabel`, `badgeText`, `formatClock`, `formatProbability`, `CONFIDENCE_COLOR`, `CONFIDENCE_LABEL` and `predictionStatusText` (Task 7). Also `Popover`, `PopoverTrigger` and `PopoverContent` from `@/components/ui/popover`, and `getColorFromArea` and `capitalizeFirstLetter` from `@/lib/utils`.
- Produces: `default function PredictionList({ mapRef })`, with the same props as today (`SidebarSections.tsx` is unchanged).

- [ ] **Step 1: Replace** `PredictionList.tsx`:

```tsx
import { RefObject, useState } from 'react';
import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { MapRef } from '@/components/Map';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { usePredictions } from '@/hooks/predictions.hook';
import useInterval from '@/hooks/utils/interval.hook';
import useSidebarStore from '@/stores/sidebar.store';
import { ageLabel, CONFIDENCE_COLOR, CONFIDENCE_LABEL, formatClock, formatProbability, predictionStatusText } from '@/lib/prediction';
import { capitalizeFirstLetter, cn, getColorFromArea } from '@/lib/utils';
import type { Prediction } from '@/types/Prediction';

const FLY_TO_ZOOM = 14;
const TICK_MS = 30_000;

/** One card per fox team: AI pin, top-3 groups as bars with ETA; tap flies to the pin, ⓘ shows the AI's reason. */
export default function PredictionList({ mapRef }: { mapRef: RefObject<MapRef | null> }) {
  const { predictions } = usePredictions();
  const setSheetSnap = useSidebarStore((state) => state.setSheetSnap);
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), TICK_MS);

  if (!predictions) {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }
  if (predictions.length === 0) return <p className="text-xs text-muted-foreground">Nog geen voorspellingen.</p>;

  function flyTo(prediction: Prediction) {
    const point = prediction.pin ?? prediction.lastObservation;
    if (!point) return;
    mapRef.current?.flyTo({ center: [point.lng, point.lat], zoom: FLY_TO_ZOOM, duration: 1500 });
    // On phones, lower the bottom sheet so the pin is visible
    setSheetSnap('peek');
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {predictions.map((prediction) => {
        const color = getColorFromArea(prediction.area);
        const status = predictionStatusText(prediction);
        return (
          <li
            key={prediction.area}
            data-prediction-area={prediction.area}
            className={cn('relative overflow-hidden rounded-lg border bg-card pl-3 text-xs', prediction.stale && 'opacity-60')}
          >
            <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} aria-hidden="true" />
            <div className="flex items-center gap-1.5 py-1.5 pr-1">
              <button
                type="button"
                onClick={() => flyTo(prediction)}
                disabled={!prediction.pin && !prediction.lastObservation}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-semibold disabled:cursor-default"
              >
                {capitalizeFirstLetter(prediction.area)}
                {prediction.confidence && (
                  <span
                    className={cn('size-2 shrink-0 rounded-full', CONFIDENCE_COLOR[prediction.confidence])}
                    title={CONFIDENCE_LABEL[prediction.confidence]}
                    aria-label={CONFIDENCE_LABEL[prediction.confidence]}
                  />
                )}
              </button>
              {prediction.stale && (
                <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-600" aria-label={prediction.error ?? 'Verouderd'}>
                  <title>{prediction.error ?? 'Verouderd'}</title>
                </TriangleAlertIcon>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground" title={`Bijgewerkt ${formatClock(prediction.updatedAt)}`}>
                {ageLabel(prediction.updatedAt, now)}
              </span>
              {prediction.why && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label="Waarom?">
                      <InfoIcon className="size-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="left" className="w-56 p-2 text-xs">
                    {prediction.why}
                  </PopoverContent>
                </Popover>
              )}
            </div>
            {status ? (
              <p className="truncate pb-1.5 pr-2 text-muted-foreground">{status}</p>
            ) : (
              <button type="button" onClick={() => flyTo(prediction)} className="flex w-full flex-col gap-1 pb-2 pr-2 text-left">
                {prediction.candidates.map((candidate) => (
                  <span key={candidate.teamApiId} className="grid grid-cols-[minmax(0,1fr)_3.5rem_2.25rem_2.75rem] items-center gap-1.5">
                    <span className="truncate">{candidate.name}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full" style={{ width: `${Math.round(candidate.probability * 100)}%`, backgroundColor: color }} />
                    </span>
                    <span className="text-right tabular-nums">{formatProbability(candidate.probability)}</span>
                    <span className="rounded bg-muted px-1 text-center tabular-nums">{formatClock(candidate.eta)}</span>
                  </span>
                ))}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

If `lucide-react` icons do not accept a `<title>` child (TypeScript error), drop the `<title>` element and wrap the icon in `<span title={prediction.error ?? 'Verouderd'}>…</span>`.

- [ ] **Step 2: Type-check this file.** Run `cd CLIENT && bunx tsc -b 2>&1 | grep -i PredictionList`. Expected: no output. Errors in `layers/Predictions.tsx` are expected until Task 9.

- [ ] **Step 3: Commit.**

```bash
git add src/components/sidebar/PredictionList.tsx
git commit -m "feat: prediction cards with probability bars, ETA chips and AI reason popover"
```

---

### Task 9: Map layer (pulsing pin, line, badges) and verification

**Files (CLIENT):**
- Rewrite: `src/components/layers/Predictions.tsx`

**Interfaces:**
- Consumes: `buildPredictionMap`, `MapPin` and `MapBadge` (Task 7).

- [ ] **Step 1: Replace** `Predictions.tsx`:

```tsx
import { useMemo } from 'react';
import { PawPrintIcon } from 'lucide-react';
import { Layer, Marker, Source } from 'react-map-gl/maplibre';
import { useAreas } from '@/hooks/areas.hook';
import { usePredictions } from '@/hooks/predictions.hook';
import { buildPredictionMap } from '@/lib/prediction';
import { cn, getColorFromArea } from '@/lib/utils';

/** AI prediction: pulsing fox pin per area, dashed line from the last observation, ring + "62% 14:20" badge on the top groups. */
export default function Predictions() {
  const { predictions } = usePredictions();
  const { hiddenAreas } = useAreas();

  const data = useMemo(
    () => buildPredictionMap((predictions ?? []).filter((prediction) => !hiddenAreas.includes(prediction.area.toLowerCase())), getColorFromArea),
    [predictions, hiddenAreas],
  );

  return (
    <>
      <Source id="prediction-lines" type="geojson" data={data.lines}>
        <Layer
          id="prediction-pin-lines"
          type="line"
          layout={{ 'line-cap': 'round' }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.8, 'line-dasharray': [2, 2] }}
        />
      </Source>
      {data.badges.map((badge) => (
        <Marker key={badge.key} longitude={badge.lng} latitude={badge.lat} anchor="center" style={{ pointerEvents: 'none' }}>
          <span className="relative flex flex-col items-center">
            <span className={cn('rounded-full border-[3px]', badge.rank === 0 ? 'size-11' : 'size-9 opacity-70')} style={{ borderColor: badge.color }} />
            <span
              className="absolute top-full mt-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-white shadow"
              style={{ backgroundColor: badge.color, opacity: badge.rank === 0 ? 1 : 0.8 }}
            >
              {badge.text}
            </span>
          </span>
        </Marker>
      ))}
      {data.pins.map((pin) => (
        <Marker key={`pin-${pin.area}`} longitude={pin.lng} latitude={pin.lat} anchor="center" style={{ pointerEvents: 'none' }}>
          <span className={cn('relative flex size-9 items-center justify-center', pin.stale && 'grayscale')}>
            {!pin.stale && <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ backgroundColor: pin.color }} />}
            <span className="relative flex size-7 items-center justify-center rounded-full text-white shadow-md ring-2 ring-white" style={{ backgroundColor: pin.color }}>
              <PawPrintIcon className="size-4" aria-label={`Voorspelde positie ${pin.area}`} />
            </span>
          </span>
        </Marker>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Run the full client check.** Run `cd CLIENT && bunx tsc -b && bun test && bun run lint`. Expected: no errors, all tests PASS. Fix anything that still imports `candidateLabel`, `predictionAccuracyText`, `isPredictionStale` or `buildPredictionGeoJson` (use `grep -rn` to find it) by switching to the Task 7 helpers.

- [ ] **Step 3: Commit.**

```bash
git add src/components/layers/Predictions.tsx
git commit -m "feat: pulsing AI fox pin with dashed line and group ETA badges"
```

- [ ] **Step 4: End-to-end check** (manual, with the running app and a real `GEMINI_API_KEY`):
  1. Run `cd SERVER && bun run seed-prediction`. Expected: alpha and oscar print a confidence, candidates and a Dutch reason. No error is printed unless the key is missing.
  2. Start the client (use the `run` skill or `bun run dev`) and log in. Expected:
     - The sidebar "Voorspelling" shows cards with bars.
     - The map shows pulsing pins, dashed lines and badges.
     - Tapping ⓘ shows the reason.
  3. Mark a group "Niet bezocht" in its popup. Expected: after about 30–60 s the prediction refreshes.
  4. Run `bun run seed-prediction --clean`.

- [ ] **Step 5: Update the spec** to match these choices:
  - ETA as `etaMinutes`.
  - `round` in the Gemini output.
  - No deletion of automatic visits at startup (old auto docs are simply ignored).
  - Visited groups shown via the existing check badge.

  Then commit in SERVER:

```bash
git add docs/superpowers/specs/2026-09-29-gemini-prediction-design.md
git commit -m "docs: align Gemini prediction spec with plan"
```
