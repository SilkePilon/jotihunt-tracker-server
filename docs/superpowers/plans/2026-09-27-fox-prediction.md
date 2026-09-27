# Fox Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per fox team (deelgebied), predict where the team is now (a growing zone) and the 1–3 most likely next groups with ETA, learning live from observations and accounting for public transport, and show it on the map, in the sidebar and in the group popup.

**Architecture:** Server: small pure modules under `src/services/prediction/` (geo, tour, scoring, visits/rounds, learning, zones, transit maths, straight-line fallback router) carry all logic and are unit-tested without network. Routing clients (ORS, Transitous, Overpass) sit behind `WalkingRouter` / `TransitPlanner` / `StopSource` interfaces and are injected into `createPredictionService`, which recomputes one area at a time (per-area lock, per-area error isolation), caches routing results in Mongo (`RoutingCache`) and stores the result per area (`Prediction`) so `GET /predictions` is a plain read. A cron (every minute) recomputes areas whose inputs changed or whose prediction is ≥ 5 minutes old. Client: SWR hooks (15 s), pure helpers in `src/lib/prediction.ts`, a MapLibre layer, visit controls in the group popup and a "Voorspelling" sidebar section.

**Tech Stack:** Bun 1, Express 5, Mongoose 9, express-validator 7, axios, node-cron 4, @turf/* 7.4 (server); React 19, Vite 8, Tailwind 4 + shadcn/ui (new-york), zustand 5, SWR 2, react-map-gl 8 / MapLibre 6, date-fns 4, lucide-react (client).

**Spec:** `docs/superpowers/specs/2026-09-27-fox-prediction-design.md`

## Global Constraints

- Repos: `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server` and `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`, branch `feat/fox-prediction` in both (already checked out). Do not push. Each task header says which repo it runs in; run commands from that repo root.
- Bun is **not installed on the host**. Every `bun_` command below means one of these shell functions (define it in each shell session):
  - Server (needs the Mongo test DB):
    ```bash
    bun_() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network jotihunt_default \
      -e MONGO_URI_TEST=mongodb://mongodb:27017/jotihunt-test \
      -v "$PWD":/app -w /app oven/bun:1 bun "$@"; }
    ```
    Requires the local stack network: `cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d mongodb`.
  - Client:
    ```bash
    bun_() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app oven/bun:1 bun "$@"; }
    ```
- Server tests use **no network**: routing clients are injected; tests use `straightLineRouter` or hand-written mocks. HTTP clients take an injectable `post`/`get` function.
- Server files under `src/services/` and `src/models/` must **not** import `logger` from `".."` (that import boots the whole server). Only controllers/crons may.
- Area names are **lowercase** in everything this feature stores (`GroupVisit.area`, `Prediction.area`, `PredictionModel.area`). `Area.name` (e.g. `Alpha`) and `Team.area` may be capitalised: always compare case-insensitively.
- Spec numbers (copy exactly): visit radius **300 m**; heading only if the last two observations are **≥ 200 m** and **≤ 3 h** apart; cluster radius **1.5 km**; softmax temperature **0.15**; publish top **3**; elapsed capped at **120 min**; `speedFactor` start **1.0**, clamp **0.5–1.6**; `dwellMinutes` start **15**, clamp **0–45**; weights start `wTime 1.0, wHeading 0.5, wTour 0.7, wCluster 0.3`, each clamp **0–2**; EMA **α = 0.3**; weight step **0.1**; fallback **straight line × 1.3 at 5 km/h**; stop radius **250 m**; stops bbox = all groups **+ 10 km**; max **3** islands; transit cache **30 min**; 30-minute repeat rule; recompute every **5 minutes** or on change.
- External requests: ≤ 1 request/s per provider, header `User-Agent: jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)`, **no personal data** (no email, no names) in any request. ORS key goes in the `Authorization` header.
- Prediction texts (Dutch, exact): `Inactief, voorspelling gepauzeerd`, `Nog geen waarnemingen`, `(schatting)`, `had er al kunnen zijn`, section title `Voorspelling`, buttons `Bezocht` / `Niet bezocht` / `Automatisch`.
- Client: UI copy Dutch. `bun test` only covers pure `src/lib/*.test.ts` (excluded from `tsc -b`); lib files used by tests must use `import type` for type-only imports. React Compiler lint rules are strict: no ref reads during render.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Decisions where the spec is silent or ambiguous (decided here, do not re-litigate):
  1. Candidates in the API also carry `lng`/`lat` (the client needs them to draw lines).
  2. Visits are recomputed from scratch on every area recompute from all observations (routes come from the cache, so this costs no new ORS calls): auto `GroupVisit` docs of the area are replaced, manual docs are never touched. The current round is stored on the area's `Prediction` doc (`round`) and used by `GET /visits` and `PUT /visits/:teamApiId`. `PUT … {state:'auto'}` deletes the team's newest manual doc; `visited`/`not_visited` apply to the area's current round.
  3. Learning guards: a speed sample is only taken when the ORS route between the two hints is ≥ 500 m, Δt ≤ 180 min and Δt − dwell ≥ 5 min. The dwell sample is `(time of the first later observation > 300 m from the group − visitedAt) − straight-line travel time from the group to that observation`, ignored when > 120 min.
  4. The snapshot's reference time is the time of the observation that prediction was based on (hint marker times are hour-floored and entered late, so the prediction's `updatedAt` would be wrong).
  5. Zones use 10-minute buckets: `outer = max(10, ceil(elapsed · speedFactor / 10) · 10)` min, `core = outer / 2`. One ORS isochrone call per position requests the fixed ranges `[5,10,15,20,25,30,40,50,60]` min (ORS allows ≤ 10 ranges; the public API is assumed to cap foot isochrones at 60 min). Ranges > 60 min use a circle (radius = minutes × 83.33 m/min ÷ 1.3) without setting `estimate`.
  6. Transit travel time = itinerary `endTime − (lastObservation.time + dwell)` (includes waiting). Transitous itinerary with only WALK legs counts as "no transit".
  7. Transit stops are fetched when the `TransitStop` collection is empty (checked by the cron, at most once per hour) and via the admin endpoint; Overpass has a mirror fallback URL.
  8. Areas without groups get `reason: "Geen groepen gekoppeld"` and no routing calls.
  9. Service-level tests replace HTTP controller tests (controllers are thin wrappers, verified by a curl smoke test).
  10. Map labels are HTML markers (emoji + no glyph/font dependency in the map styles). The sidebar section `predictions` is closed by default.

## File Structure

Server (`jotihunt-tracker-server/`), all new unless noted:
- `src/services/prediction/constants.ts` — every tunable number from the spec + User-Agent.
- `src/services/prediction/types.ts` — `LngLat`, `PolygonGeometry`, `Observation`, `GroupRef`, `Weights`, `TermValues`, `DEFAULT_PARAMS`.
- `src/services/prediction/geo.ts` — turf wrappers: distance, bearing, angle diff, circle, point-to-line, `moveM`, `paddedBbox`.
- `src/services/prediction/tour.ts` — nearest-neighbour + 2-opt open tour.
- `src/services/prediction/scoring.ts` — heading, the four terms, softmax, candidate scoring.
- `src/services/prediction/visits.ts` — point/route visit detection, round assignment, 30-min rule, candidate ids.
- `src/services/prediction/learning.ts` — clamp, EMA, speed/dwell samples, weight step, accuracy.
- `src/services/prediction/zones.ts` — elapsed, zone buckets, circle zones, ring picking.
- `src/services/prediction/routing.ts` — router/planner/stop-source interfaces + error classes.
- `src/services/prediction/transit.ts` — transit-mode triggers, min(walk, transit), labels, islands.
- `src/services/prediction/straight-line.router.ts` — fallback `WalkingRouter` (straight line × 1.3 at 5 km/h, circle isochrones).
- `src/services/prediction/http.ts` — throttle, daily counter, injectable HTTP function types.
- `src/services/prediction/ors.client.ts`, `transitous.client.ts`, `overpass.client.ts` — real clients.
- `src/models/group-visit.model.ts`, `prediction-model.model.ts` (`PredictionModel`), `prediction.model.ts` (`Prediction`), `routing-cache.model.ts`, `transit-stop.model.ts`.
- `src/services/prediction/routing-cache.ts`, `visit.service.ts`, `transit-stop.service.ts` — DB helpers.
- `src/services/prediction/prediction.service.ts` — orchestration (`createPredictionService`, `listPredictions`).
- `src/services/prediction/instance.ts` — singleton wiring real clients.
- `src/test/prediction-fixtures.ts` — `makeTeam`, `addObservation`, `setAreaStatus`.
- `src/controllers/predictions.controller.ts`, `src/routes/predictions.route.ts`, `src/routes/visits.route.ts`, `src/crons/prediction.cron.ts`; modify `src/routes/admin.route.ts`, `src/index.ts`.
- `src/scripts/seed-prediction.ts`; modify `package.json`, `.env.example`, `README.md`.
- Tests: `*.test.ts` next to each pure module/service + `src/services/prediction/replay.test.ts`.

Root (`/home/silke/Documents/Jotihunt 2026/`, not a git repo): modify `.env.example` and `.env` (add empty `ORS_API_KEY=`).

Client (`jotihunt-tracker-client/`):
- Create `src/types/Prediction.ts`, `src/hooks/predictions.hook.ts`, `src/lib/prediction.ts` (+ `src/lib/prediction.test.ts`).
- Create `src/components/layers/Predictions.tsx`, `src/components/map/VisitControls.tsx`, `src/components/sidebar/PredictionList.tsx`.
- Modify `src/stores/layers.store.ts`, `src/stores/sidebar.store.ts`, `src/components/Settings.tsx`, `src/components/Map.tsx`, `src/components/layers/Teams.tsx`, `src/components/sidebar/SidebarSections.tsx`.

Task order: 1–8 server, 9–11 client, 12 end-to-end.

---
### Task 1: Geometry, tour and scoring core (server)

**Files:**
- Modify: `package.json`, `bun.lock` (add `@turf/*` packages)
- Create: `src/services/prediction/constants.ts`, `src/services/prediction/types.ts`, `src/services/prediction/geo.ts`, `src/services/prediction/tour.ts`, `src/services/prediction/scoring.ts`
- Test: `src/services/prediction/geo.test.ts`, `src/services/prediction/tour.test.ts`, `src/services/prediction/scoring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - constants: `VISIT_RADIUS_M, HEADING_MIN_DISTANCE_M, HEADING_MAX_GAP_MIN, CLUSTER_RADIUS_M, SOFTMAX_TEMPERATURE, TOP_CANDIDATES, ELAPSED_CAP_MIN, WALK_M_PER_MIN, DETOUR_FACTOR, STOP_RADIUS_M, REPEAT_EXCLUSION_MIN, EMA_ALPHA, WEIGHT_STEP, SPEED_FACTOR_RANGE, DWELL_RANGE, WEIGHT_RANGE, MAX_ISLANDS, TRANSIT_CACHE_MS, RECOMPUTE_INTERVAL_MS, USER_AGENT`
  - types: `LngLat = [number, number]`, `PolygonGeometry { type: "Polygon"; coordinates: number[][][] }`, `ObservationKind = "hint" | "hunt" | "spot"`, `Observation { time: Date; lng: number; lat: number; kind: ObservationKind }`, `GroupRef { teamApiId: number; name: string; lng: number; lat: number }`, `Weights { wTime; wHeading; wTour; wCluster }`, `TermValues { time; heading; tour; cluster }`, `ModelParams`, `DEFAULT_PARAMS`
  - geo: `distanceM(a: LngLat, b: LngLat): number`, `bearingDeg(a, b): number`, `angleDiffDeg(a: number, b: number): number`, `circlePolygon(center: LngLat, radiusM: number): PolygonGeometry`, `pointToLine(p: LngLat, line: LngLat[]): { distanceM: number; fraction: number }`, `moveM(origin: LngLat, eastM: number, northM: number): LngLat`, `paddedBbox(points: LngLat[], padM: number): [number, number, number, number]`
  - tour: `planTour(startCosts: number[], matrix: number[][]): number[]`, `tourCost(tour, startCosts, matrix): number`, `twoOpt(tour, startCosts, matrix): number[]`
  - scoring: `computeHeading(observations: Observation[]): number | null`, `interface ScoringCandidate { teamApiId: number; location: LngLat; travelMinutes: number }`, `interface ScoringInput { position: LngLat; heading: number | null; candidates: ScoringCandidate[]; tourFirstIndex: number | null; weights: Weights }`, `interface ScoredCandidate { teamApiId: number; terms: TermValues; score: number; probability: number }`, `computeTerms(input): TermValues[]`, `weightedScore(terms, weights): number`, `softmax(scores: number[], temperature?: number): number[]`, `scoreCandidates(input): ScoredCandidate[]` (same order as input)

- [ ] **Step 1: Add turf packages**

Run: `bun_ add @turf/bearing @turf/circle @turf/distance @turf/helpers @turf/length @turf/nearest-point-on-line`
Expected: `package.json` `dependencies` gains the six `@turf/*` entries at `^7.4.0`.

- [ ] **Step 2: Constants and types** — `src/services/prediction/constants.ts`

```ts
/** Distance from a group that counts as "at the group". */
export const VISIT_RADIUS_M = 300;
/** Heading is only used when the last two observations are at least this far apart… */
export const HEADING_MIN_DISTANCE_M = 200;
/** …and at most this many minutes apart. */
export const HEADING_MAX_GAP_MIN = 180;
export const CLUSTER_RADIUS_M = 1500;
export const SOFTMAX_TEMPERATURE = 0.15;
export const TOP_CANDIDATES = 3;
export const ELAPSED_CAP_MIN = 120;
/** ORS foot-walking speed (5 km/h) in metres per minute. */
export const WALK_M_PER_MIN = 5000 / 60;
/** Straight-line distance × this factor approximates the walking distance. */
export const DETOUR_FACTOR = 1.3;
export const STOP_RADIUS_M = 250;
/** The last group of a round may only start the next round this many minutes later. */
export const REPEAT_EXCLUSION_MIN = 30;
export const EMA_ALPHA = 0.3;
export const WEIGHT_STEP = 0.1;
export const SPEED_FACTOR_RANGE: [number, number] = [0.5, 1.6];
export const DWELL_RANGE: [number, number] = [0, 45];
export const WEIGHT_RANGE: [number, number] = [0, 2];
export const MAX_ISLANDS = 3;
export const TRANSIT_CACHE_MS = 30 * 60 * 1000;
export const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;
export const USER_AGENT = "jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)";
```

`src/services/prediction/types.ts`

```ts
export type LngLat = [number, number];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

export type ObservationKind = "hint" | "hunt" | "spot";

export interface Observation {
  time: Date;
  lng: number;
  lat: number;
  kind: ObservationKind;
}

export interface GroupRef {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
}

export interface Weights {
  wTime: number;
  wHeading: number;
  wTour: number;
  wCluster: number;
}

export interface TermValues {
  time: number;
  heading: number;
  tour: number;
  cluster: number;
}

export interface ModelParams {
  speedFactor: number;
  dwellMinutes: number;
  weights: Weights;
}

export const DEFAULT_PARAMS: ModelParams = {
  speedFactor: 1,
  dwellMinutes: 15,
  weights: { wTime: 1, wHeading: 0.5, wTour: 0.7, wCluster: 0.3 },
};
```

- [ ] **Step 3: Write the failing geo test** — `src/services/prediction/geo.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { angleDiffDeg, bearingDeg, circlePolygon, distanceM, moveM, paddedBbox, pointToLine } from "./geo";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];

describe("geo", () => {
  test("moveM and distanceM agree", () => {
    expect(distanceM(O, moveM(O, 1000, 0))).toBeCloseTo(1000, -1);
    expect(distanceM(O, moveM(O, 0, -2500))).toBeCloseTo(2500, -1);
  });

  test("bearingDeg points east / north", () => {
    expect(bearingDeg(O, moveM(O, 1000, 0))).toBeCloseTo(90, 0);
    expect(bearingDeg(O, moveM(O, 0, 1000))).toBeCloseTo(0, 0);
  });

  test("angleDiffDeg wraps around", () => {
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20, 6);
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180, 6);
    expect(angleDiffDeg(-90, 90)).toBeCloseTo(180, 6);
  });

  test("circlePolygon is a closed polygon at the radius", () => {
    const circle = circlePolygon(O, 800);
    expect(circle.type).toBe("Polygon");
    const ring = circle.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(distanceM(O, ring[0] as LngLat)).toBeCloseTo(800, -1);
  });

  test("pointToLine gives distance and fraction along the line", () => {
    const line: LngLat[] = [O, moveM(O, 2000, 0)];
    const result = pointToLine(moveM(O, 1000, 100), line);
    expect(result.distanceM).toBeCloseTo(100, -1);
    expect(result.fraction).toBeCloseTo(0.5, 2);
  });

  test("paddedBbox pads all sides", () => {
    const [west, south, east, north] = paddedBbox([O, moveM(O, 1000, 1000)], 10_000);
    expect(distanceM([west, O[1]], O)).toBeCloseTo(10_000, -2);
    expect(south).toBeLessThan(O[1]);
    expect(east).toBeGreaterThan(moveM(O, 1000, 0)[0]);
    expect(north).toBeGreaterThan(moveM(O, 0, 1000)[1]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun_ test src/services/prediction/geo.test.ts`
Expected: FAIL — `Cannot find module './geo'`.

- [ ] **Step 5: Implement** — `src/services/prediction/geo.ts`

```ts
import bearing from "@turf/bearing";
import circle from "@turf/circle";
import distance from "@turf/distance";
import { lineString, point } from "@turf/helpers";
import turfLength from "@turf/length";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { LngLat, PolygonGeometry } from "./types";

const METERS_PER_DEGREE_LAT = 111_320;

/** Great-circle distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  return distance(a, b, { units: "meters" });
}

/** Initial compass bearing from a to b in degrees (-180..180, 0 = north). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  return bearing(a, b);
}

/** Smallest absolute difference between two bearings, 0..180 degrees. */
export function angleDiffDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** A circle as a GeoJSON polygon. */
export function circlePolygon(center: LngLat, radiusM: number): PolygonGeometry {
  const feature = circle(center, Math.max(radiusM, 1), { units: "meters", steps: 48 });
  return { type: "Polygon", coordinates: feature.geometry.coordinates };
}

/**
 * Distance from a point to a polyline, and where along the line (0..1) the closest point lies.
 */
export function pointToLine(p: LngLat, line: LngLat[]): { distanceM: number; fraction: number } {
  if (line.length < 2) return { distanceM: distanceM(p, line[0] ?? p), fraction: 0 };
  const feature = lineString(line);
  const total = turfLength(feature, { units: "meters" });
  const nearest = nearestPointOnLine(feature, point(p), { units: "meters" });
  return {
    distanceM: nearest.properties.pointDistance,
    fraction: total > 0 ? nearest.properties.lineDistance / total : 0,
  };
}

/** Move a coordinate by metres east/north (equirectangular, fine for a few km). */
export function moveM([lng, lat]: LngLat, eastM: number, northM: number): LngLat {
  const dLat = northM / METERS_PER_DEGREE_LAT;
  const dLng = eastM / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return [lng + dLng, lat + dLat];
}

/** Bounding box [west, south, east, north] around the points, padded by padM metres. */
export function paddedBbox(points: LngLat[], padM: number): [number, number, number, number] {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const [west, south] = moveM([Math.min(...lngs), Math.min(...lats)], -padM, -padM);
  const [east, north] = moveM([Math.max(...lngs), Math.max(...lats)], padM, padM);
  return [west, south, east, north];
}
```

- [ ] **Step 6: Run** `bun_ test src/services/prediction/geo.test.ts` → all PASS.

- [ ] **Step 7: Write the failing tour test** — `src/services/prediction/tour.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { planTour, tourCost } from "./tour";

// Nodes on a line at x = 1, -2, 4; the start is at x = 0.
const xs = [1, -2, 4];
const startCosts = xs.map((x) => Math.abs(x));
const matrix = xs.map((a) => xs.map((b) => Math.abs(a - b)));

describe("planTour", () => {
  test("2-opt improves the nearest-neighbour tour", () => {
    // Nearest neighbour gives [0, 1, 2] (cost 10); reversing the first two gives [1, 0, 2] (cost 8).
    expect(tourCost([0, 1, 2], startCosts, matrix)).toBe(10);
    const tour = planTour(startCosts, matrix);
    expect(tour).toEqual([1, 0, 2]);
    expect(tourCost(tour, startCosts, matrix)).toBe(8);
  });

  test("handles empty and single-node input", () => {
    expect(planTour([], [])).toEqual([]);
    expect(planTour([5], [[0]])).toEqual([0]);
  });

  test("returns a permutation for asymmetric costs", () => {
    const tour = planTour([3, 1, 2], [
      [0, 5, 1],
      [2, 0, 9],
      [4, 1, 0],
    ]);
    expect([...tour].sort()).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 8: Run** `bun_ test src/services/prediction/tour.test.ts` → FAIL (`Cannot find module './tour'`).

- [ ] **Step 9: Implement** — `src/services/prediction/tour.ts`

```ts
/**
 * Cost of an open tour that starts at the fixed start position.
 * @param tour Node indices in visiting order
 * @param startCosts Cost from the start position to node i
 * @param matrix Cost from node i to node j
 */
export function tourCost(tour: number[], startCosts: number[], matrix: number[][]): number {
  if (tour.length === 0) return 0;
  let cost = startCosts[tour[0]];
  for (let i = 1; i < tour.length; i++) cost += matrix[tour[i - 1]][tour[i]];
  return cost;
}

/** Improve an open tour by reversing segments until no reversal helps (costs may be asymmetric). */
export function twoOpt(tour: number[], startCosts: number[], matrix: number[][]): number[] {
  let best = [...tour];
  let bestCost = tourCost(best, startCosts, matrix);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const cost = tourCost(candidate, startCosts, matrix);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Shortest open tour from a fixed start through all nodes: nearest neighbour, then 2-opt.
 * @returns Node indices in visiting order (first element = first stop)
 */
export function planTour(startCosts: number[], matrix: number[][]): number[] {
  const remaining = new Set(startCosts.map((_, index) => index));
  const tour: number[] = [];
  let current = -1;
  while (remaining.size > 0) {
    let best = -1;
    let bestCost = Infinity;
    for (const node of remaining) {
      const cost = current === -1 ? startCosts[node] : matrix[current][node];
      if (best === -1 || cost < bestCost) {
        best = node;
        bestCost = cost;
      }
    }
    tour.push(best);
    remaining.delete(best);
    current = best;
  }
  return twoOpt(tour, startCosts, matrix);
}
```

- [ ] **Step 10: Run** `bun_ test src/services/prediction/tour.test.ts` → PASS.

- [ ] **Step 11: Write the failing scoring test** — `src/services/prediction/scoring.test.ts`

```ts
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
```

- [ ] **Step 12: Run** `bun_ test src/services/prediction/scoring.test.ts` → FAIL (`Cannot find module './scoring'`).

- [ ] **Step 13: Implement** — `src/services/prediction/scoring.ts`

```ts
import { CLUSTER_RADIUS_M, HEADING_MAX_GAP_MIN, HEADING_MIN_DISTANCE_M, SOFTMAX_TEMPERATURE } from "./constants";
import { angleDiffDeg, bearingDeg, distanceM } from "./geo";
import type { LngLat, Observation, TermValues, Weights } from "./types";

export interface ScoringCandidate {
  teamApiId: number;
  location: LngLat;
  /** Effective travel time (walking / speedFactor, or transit) */
  travelMinutes: number;
}

export interface ScoringInput {
  position: LngLat;
  heading: number | null;
  candidates: ScoringCandidate[];
  /** Index (into candidates) of the first stop of the shortest tour, or null */
  tourFirstIndex: number | null;
  weights: Weights;
}

export interface ScoredCandidate {
  teamApiId: number;
  terms: TermValues;
  score: number;
  probability: number;
}

/**
 * Heading of the fox team: bearing between the last two observations, if they are
 * at least 200 m and at most 3 h apart.
 * @param observations Observations sorted by time ascending
 */
export function computeHeading(observations: Observation[]): number | null {
  if (observations.length < 2) return null;
  const [previous, last] = observations.slice(-2);
  const gapMinutes = (last.time.getTime() - previous.time.getTime()) / 60_000;
  const from: LngLat = [previous.lng, previous.lat];
  const to: LngLat = [last.lng, last.lat];
  if (gapMinutes > HEADING_MAX_GAP_MIN || distanceM(from, to) < HEADING_MIN_DISTANCE_M) return null;
  return bearingDeg(from, to);
}

/** The four normalised (0–1) score terms per candidate. */
export function computeTerms(input: ScoringInput): TermValues[] {
  const { position, heading, candidates, tourFirstIndex } = input;
  const maxTravel = Math.max(0, ...candidates.map((candidate) => candidate.travelMinutes));
  return candidates.map((candidate, index) => {
    const time = maxTravel > 0 ? 1 - candidate.travelMinutes / maxTravel : 1;
    const headingTerm =
      heading === null ? 0 : Math.max(0, Math.cos((angleDiffDeg(heading, bearingDeg(position, candidate.location)) * Math.PI) / 180));
    const tour = tourFirstIndex === index ? 1 : 0;
    const neighbours = candidates.filter(
      (other, otherIndex) => otherIndex !== index && distanceM(other.location, candidate.location) <= CLUSTER_RADIUS_M,
    ).length;
    return { time, heading: headingTerm, tour, cluster: neighbours / candidates.length };
  });
}

export function weightedScore(terms: TermValues, weights: Weights): number {
  return weights.wTime * terms.time + weights.wHeading * terms.heading + weights.wTour * terms.tour + weights.wCluster * terms.cluster;
}

/** Softmax of score / temperature (max-subtracted for stability). */
export function softmax(scores: number[], temperature = SOFTMAX_TEMPERATURE): number[] {
  if (scores.length === 0) return [];
  const scaled = scores.map((score) => score / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** Score every candidate; the result has the same order as input.candidates. */
export function scoreCandidates(input: ScoringInput): ScoredCandidate[] {
  const terms = computeTerms(input);
  const scores = terms.map((candidateTerms) => weightedScore(candidateTerms, input.weights));
  const probabilities = softmax(scores);
  return input.candidates.map((candidate, index) => ({
    teamApiId: candidate.teamApiId,
    terms: terms[index],
    score: scores[index],
    probability: probabilities[index],
  }));
}
```

- [ ] **Step 14: Run tests and static checks**

Run: `bun_ test src/services/prediction/` → all PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 15: Commit**

```bash
git add package.json bun.lock src/services/prediction/constants.ts src/services/prediction/types.ts src/services/prediction/geo.ts src/services/prediction/geo.test.ts src/services/prediction/tour.ts src/services/prediction/tour.test.ts src/services/prediction/scoring.ts src/services/prediction/scoring.test.ts
git commit -m "feat(prediction): add geometry, tour and scoring core

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: Visit detection, rounds and the 30-minute rule (server)

**Files:**
- Create: `src/services/prediction/visits.ts`
- Test: `src/services/prediction/visits.test.ts`

**Interfaces:**
- Consumes: `distanceM`, `pointToLine` (Task 1), `VISIT_RADIUS_M`, `REPEAT_EXCLUSION_MIN`, types `GroupRef`, `LngLat`, `Observation`.
- Produces:
  - `type VisitStateValue = "visited" | "not_visited"`
  - `interface VisitEvent { teamApiId: number; time: Date; evidence: "point" | "route" }`
  - `interface ManualVisit { teamApiId: number; round: number; state: VisitStateValue; visitedAt?: Date | null }`
  - `interface AutoVisit { teamApiId: number; round: number; visitedAt: Date; evidence: "point" | "route" }`
  - `interface RoundState { currentRound: number; visitedInCurrent: Set<number>; lastOfPrevious: { teamApiId: number; visitedAt: Date } | null; autoVisits: AutoVisit[] }`
  - `detectPointVisits(observations: Observation[], groups: GroupRef[], radiusM?: number): VisitEvent[]`
  - `detectRouteVisits(from: Observation, to: Observation, line: LngLat[], groups: GroupRef[], radiusM?: number): VisitEvent[]`
  - `assignRounds(groupIds: number[], events: VisitEvent[], manual: ManualVisit[]): RoundState`
  - `candidateIds(groupIds: number[], state: RoundState, now: Date): number[]`

- [ ] **Step 1: Write the failing test** — `src/services/prediction/visits.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { moveM } from "./geo";
import type { GroupRef, LngLat, Observation } from "./types";
import { assignRounds, candidateIds, detectPointVisits, detectRouteVisits, type VisitEvent } from "./visits";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const group = (teamApiId: number, [lng, lat]: LngLat): GroupRef => ({ teamApiId, name: `G${teamApiId}`, lng, lat });
const obs = (minutes: number, [lng, lat]: LngLat): Observation => ({ time: at(minutes), lng, lat, kind: "hint" });
const event = (teamApiId: number, minutes: number, evidence: VisitEvent["evidence"] = "point"): VisitEvent => ({ teamApiId, time: at(minutes), evidence });

describe("detectPointVisits", () => {
  test("an observation within 300 m of a group is a visit", () => {
    const groups = [group(1, moveM(O, 200, 0)), group(2, moveM(O, 400, 0))];
    expect(detectPointVisits([obs(0, O)], groups)).toEqual([{ teamApiId: 1, time: at(0), evidence: "point" }]);
  });
});

describe("detectRouteVisits", () => {
  test("a route passing within 300 m gives an interpolated visit time", () => {
    const from = obs(0, O);
    const to = obs(60, moveM(O, 2000, 0));
    const line: LngLat[] = [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ];
    const events = detectRouteVisits(from, to, line, [group(1, moveM(O, 1000, 150)), group(2, moveM(O, 1000, 600))]);
    expect(events).toHaveLength(1);
    expect(events[0].teamApiId).toBe(1);
    expect(events[0].evidence).toBe("route");
    expect(Math.abs(events[0].time.getTime() - at(30).getTime())).toBeLessThan(60_000);
  });
});

describe("assignRounds", () => {
  const ids = [1, 2];

  test("collects auto visits in round 1", () => {
    const state = assignRounds(ids, [event(1, 0)], []);
    expect(state.currentRound).toBe(1);
    expect([...state.visitedInCurrent]).toEqual([1]);
    expect(state.autoVisits).toEqual([{ teamApiId: 1, round: 1, visitedAt: at(0), evidence: "point" }]);
  });

  test("repeat detections in the same round are ignored", () => {
    expect(assignRounds(ids, [event(1, 10), event(1, 0)], []).autoVisits).toEqual([{ teamApiId: 1, round: 1, visitedAt: at(0), evidence: "point" }]);
  });

  test("ignores groups that are not part of the area", () => {
    expect(assignRounds(ids, [event(9, 0)], []).autoVisits).toEqual([]);
  });

  test("manual not_visited wins over auto", () => {
    const state = assignRounds(ids, [event(1, 0)], [{ teamApiId: 1, round: 1, state: "not_visited" }]);
    expect(state.autoVisits).toEqual([]);
    expect(state.visitedInCurrent.has(1)).toBe(false);
  });

  test("manual visited counts towards completing the round", () => {
    const state = assignRounds(ids, [event(2, 30, "route")], [{ teamApiId: 1, round: 1, state: "visited", visitedAt: at(0) }]);
    expect(state.currentRound).toBe(2);
    expect(state.lastOfPrevious).toEqual({ teamApiId: 2, visitedAt: at(30) });
    expect(state.visitedInCurrent.size).toBe(0);
  });

  test("round rollover with the 30-minute rule for the last group", () => {
    const state = assignRounds(ids, [event(1, 0), event(2, 60), event(2, 80), event(2, 100)], []);
    expect(state.currentRound).toBe(2);
    expect(state.autoVisits.map((visit) => [visit.teamApiId, visit.round, visit.visitedAt])).toEqual([
      [1, 1, at(0)],
      [2, 1, at(60)],
      [2, 2, at(100)],
    ]);
    expect([...state.visitedInCurrent]).toEqual([2]);
  });
});

describe("candidateIds", () => {
  test("excludes visited groups and the previous round's last group for 30 minutes", () => {
    const groupIds = [1, 2, 3];
    const state = assignRounds(groupIds, [event(1, 0), event(2, 30), event(3, 60)], []);
    expect(state.currentRound).toBe(2);
    expect(candidateIds(groupIds, state, at(70))).toEqual([1, 2]);
    expect(candidateIds(groupIds, state, at(91))).toEqual([1, 2, 3]);
  });

  test("excludes groups visited in the current round", () => {
    const state = assignRounds([1, 2, 3], [event(2, 0)], []);
    expect(candidateIds([1, 2, 3], state, at(10))).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun_ test src/services/prediction/visits.test.ts`
Expected: FAIL — `Cannot find module './visits'`.

- [ ] **Step 3: Implement** — `src/services/prediction/visits.ts`

```ts
import { REPEAT_EXCLUSION_MIN, VISIT_RADIUS_M } from "./constants";
import { distanceM, pointToLine } from "./geo";
import type { GroupRef, LngLat, Observation } from "./types";

export type VisitStateValue = "visited" | "not_visited";

export interface VisitEvent {
  teamApiId: number;
  time: Date;
  evidence: "point" | "route";
}

export interface ManualVisit {
  teamApiId: number;
  round: number;
  state: VisitStateValue;
  visitedAt?: Date | null;
}

export interface AutoVisit {
  teamApiId: number;
  round: number;
  visitedAt: Date;
  evidence: "point" | "route";
}

export interface RoundState {
  currentRound: number;
  visitedInCurrent: Set<number>;
  /** The group visited last in the previous round (30-minute rule), if any */
  lastOfPrevious: { teamApiId: number; visitedAt: Date } | null;
  autoVisits: AutoVisit[];
}

const REPEAT_MS = REPEAT_EXCLUSION_MIN * 60_000;

/** Every (observation, group) pair within the radius is a visit at the observation time. */
export function detectPointVisits(observations: Observation[], groups: GroupRef[], radiusM = VISIT_RADIUS_M): VisitEvent[] {
  const events: VisitEvent[] = [];
  for (const observation of observations) {
    for (const group of groups) {
      if (distanceM([observation.lng, observation.lat], [group.lng, group.lat]) <= radiusM) {
        events.push({ teamApiId: group.teamApiId, time: observation.time, evidence: "point" });
      }
    }
  }
  return events;
}

/**
 * Groups the walking route between two consecutive observations passes within the radius.
 * The visit time is interpolated along the route.
 */
export function detectRouteVisits(from: Observation, to: Observation, line: LngLat[], groups: GroupRef[], radiusM = VISIT_RADIUS_M): VisitEvent[] {
  const span = to.time.getTime() - from.time.getTime();
  return groups.flatMap((group) => {
    const { distanceM: distance, fraction } = pointToLine([group.lng, group.lat], line);
    if (distance > radiusM) return [];
    return [{ teamApiId: group.teamApiId, time: new Date(from.time.getTime() + fraction * span), evidence: "route" as const }];
  });
}

/**
 * Replay visit events in time order and split them into rounds. Manual visits always win:
 * a manual doc for (group, round) blocks auto visits for that pair, and manual `visited`
 * counts towards completing the round. A round is complete when every group is visited;
 * the next round then starts, and the group visited last may only count again 30 minutes later.
 */
export function assignRounds(groupIds: number[], events: VisitEvent[], manual: ManualVisit[]): RoundState {
  const known = new Set(groupIds);
  const autoVisits: AutoVisit[] = [];
  const progress: { round: number; lastOfPrevious: RoundState["lastOfPrevious"] } = { round: 1, lastOfPrevious: null };

  const manualFor = (teamApiId: number, round: number) => manual.find((visit) => visit.teamApiId === teamApiId && visit.round === round);
  const visitedAtIn = (teamApiId: number, round: number): Date | null => {
    const override = manualFor(teamApiId, round);
    if (override) return override.state === "visited" ? (override.visitedAt ?? new Date(0)) : null;
    return autoVisits.find((visit) => visit.teamApiId === teamApiId && visit.round === round)?.visitedAt ?? null;
  };
  const advance = () => {
    while (groupIds.length > 0 && groupIds.every((id) => visitedAtIn(id, progress.round) !== null)) {
      const visits = groupIds.map((id) => ({ teamApiId: id, visitedAt: visitedAtIn(id, progress.round) as Date }));
      visits.sort((a, b) => b.visitedAt.getTime() - a.visitedAt.getTime());
      progress.lastOfPrevious = visits[0];
      progress.round++;
    }
  };

  advance();
  for (const event of [...events].sort((a, b) => a.time.getTime() - b.time.getTime())) {
    if (!known.has(event.teamApiId)) continue;
    if (manualFor(event.teamApiId, progress.round)) continue;
    if (visitedAtIn(event.teamApiId, progress.round) !== null) continue;
    const last = progress.lastOfPrevious;
    if (last && last.teamApiId === event.teamApiId && event.time.getTime() - last.visitedAt.getTime() < REPEAT_MS) continue;
    autoVisits.push({ teamApiId: event.teamApiId, round: progress.round, visitedAt: event.time, evidence: event.evidence });
    advance();
  }

  return {
    currentRound: progress.round,
    visitedInCurrent: new Set(groupIds.filter((id) => visitedAtIn(id, progress.round) !== null)),
    lastOfPrevious: progress.lastOfPrevious,
    autoVisits,
  };
}

/** Groups that can still be visited next: not visited this round and not blocked by the 30-minute rule. */
export function candidateIds(groupIds: number[], state: RoundState, now: Date): number[] {
  return groupIds.filter((id) => {
    if (state.visitedInCurrent.has(id)) return false;
    const last = state.lastOfPrevious;
    return !(last && last.teamApiId === id && now.getTime() - last.visitedAt.getTime() < REPEAT_MS);
  });
}
```

- [ ] **Step 4: Run tests and static checks**

Run: `bun_ test src/services/prediction/visits.test.ts` → PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/prediction/visits.ts src/services/prediction/visits.test.ts
git commit -m "feat(prediction): detect group visits and track rounds

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: Learning, zones, transit maths and the straight-line fallback (server)

**Files:**
- Create: `src/services/prediction/learning.ts`, `src/services/prediction/zones.ts`, `src/services/prediction/routing.ts`, `src/services/prediction/transit.ts`, `src/services/prediction/straight-line.router.ts`
- Test: `src/services/prediction/learning.test.ts`, `src/services/prediction/zones.test.ts`, `src/services/prediction/transit.test.ts`, `src/services/prediction/straight-line.router.test.ts`

**Interfaces:**
- Consumes: constants and types (Task 1), `circlePolygon`, `distanceM`, `moveM` (Task 1).
- Produces:
  - learning: `interface Accuracy { top1Hits: number; top3Hits: number; evaluations: number }`, `interface SnapshotCandidate { teamApiId: number; probability: number; terms: TermValues }`, `clamp(value: number, range: [number, number]): number`, `ema(previous: number, sample: number, alpha?: number): number`, `speedSample(routeDistanceM: number, gapMinutes: number, dwellMinutes: number): number | null`, `updateSpeedFactor(current: number, sample: number): number`, `dwellSample(visitedAt: Date, leftAt: Date, travelMinutes: number): number | null`, `updateDwell(current: number, sample: number): number`, `updateWeights(weights: Weights, snapshot: SnapshotCandidate[], actualTeamApiId: number): Weights`, `evaluateSnapshot(accuracy: Accuracy, snapshot: SnapshotCandidate[], actualTeamApiId: number): Accuracy`
  - zones: `ISOCHRONE_RANGES_MIN = [5, 10, 15, 20, 25, 30, 40, 50, 60]`, `elapsedMinutes(now: Date, lastTime: Date, dwellMinutes: number): number`, `zoneRanges(elapsed: number, speedFactor: number): { outerMin: number; coreMin: number }`, `walkRadiusM(walkMinutes: number): number`, `circleZone(center: LngLat, walkMinutes: number): PolygonGeometry`, `pickRing(rings: Record<number, PolygonGeometry> | undefined, center: LngLat, minutes: number): PolygonGeometry`
  - routing: `class RoutingUnavailableError`, `class TransitUnavailableError`, `interface MatrixResult { durationsS: (number | null)[][]; distancesM: (number | null)[][] }`, `interface RouteResult { line: LngLat[]; distanceM: number; durationS: number }`, `interface WalkingRouter { matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult>; route(a: LngLat, b: LngLat): Promise<RouteResult>; isochrones(center: LngLat, rangesMin: number[]): Promise<Record<number, PolygonGeometry>> }`, `interface TransitPlace { name; lng; lat; arrival: Date | null; departure: Date | null }`, `interface TransitLeg { mode: string; from: TransitPlace; to: TransitPlace; line: string | null }`, `interface TransitItinerary { startTime: Date; endTime: Date; legs: TransitLeg[] }`, `interface TransitPlanner { plan(from: LngLat, to: LngLat, departAt: Date): Promise<TransitItinerary | null> }`, `type StopKind = "train" | "tram" | "bus" | "other"`, `interface StopInput { osmId: number; name: string; kind: StopKind; lng: number; lat: number }`, `type Bbox = [west, south, east, north]`, `interface StopSource { fetchStops(bbox: Bbox): Promise<StopInput[]> }`
  - transit: `isTransitMode(input: { area: string; status: string; nearestStopDistanceM: number }): boolean`, `transitKind(mode: string): string`, `transitLabel(itinerary: TransitItinerary): string | null`, `transitMinutes(itinerary: TransitItinerary, departAt: Date): number`, `interface TravelChoice { travelMinutes: number; via: "walk" | "transit"; transitLabel?: string }`, `chooseTravel(walkMinutes: number, itinerary: TransitItinerary | null, departAt: Date): TravelChoice`, `interface IslandStop { name: string; lng: number; lat: number; arrival: Date }`, `alightingStops(itineraries: TransitItinerary[]): IslandStop[]`, `selectIslands(stops: IslandStop[], now: Date, max?: number): { stop: IslandStop; remainingMinutes: number }[]`
  - straight-line: `straightLineSeconds(a: LngLat, b: LngLat): number`, `straightLineRouter: WalkingRouter`

- [ ] **Step 1: Write the failing learning test** — `src/services/prediction/learning.test.ts`

```ts
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
```

- [ ] **Step 2: Run** `bun_ test src/services/prediction/learning.test.ts` → FAIL (`Cannot find module './learning'`).

- [ ] **Step 3: Implement** — `src/services/prediction/learning.ts`

```ts
import { DWELL_RANGE, EMA_ALPHA, SPEED_FACTOR_RANGE, TOP_CANDIDATES, WALK_M_PER_MIN, WEIGHT_RANGE, WEIGHT_STEP } from "./constants";
import type { TermValues, Weights } from "./types";

export interface Accuracy {
  top1Hits: number;
  top3Hits: number;
  evaluations: number;
}

export interface SnapshotCandidate {
  teamApiId: number;
  probability: number;
  terms: TermValues;
}

/** Only learn speed from routes of at least this length (standing still says nothing about speed). */
export const MIN_SPEED_SAMPLE_DISTANCE_M = 500;
/** Skip speed samples across long gaps (breaks, swaps). */
export const MAX_SPEED_SAMPLE_GAP_MIN = 180;
export const MIN_MOVING_MINUTES = 5;
export const MAX_DWELL_SAMPLE_MIN = 120;

const TERM_KEYS: [keyof Weights, keyof TermValues][] = [
  ["wTime", "time"],
  ["wHeading", "heading"],
  ["wTour", "tour"],
  ["wCluster", "cluster"],
];

export function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

/** Exponential moving average step. */
export function ema(previous: number, sample: number, alpha = EMA_ALPHA): number {
  return previous + alpha * (sample - previous);
}

/**
 * Observed speed relative to the ORS foot speed, from the route between two hints.
 * @returns null when the sample is not meaningful
 */
export function speedSample(routeDistanceM: number, gapMinutes: number, dwellMinutes: number): number | null {
  const moving = gapMinutes - dwellMinutes;
  if (gapMinutes > MAX_SPEED_SAMPLE_GAP_MIN || moving < MIN_MOVING_MINUTES || routeDistanceM < MIN_SPEED_SAMPLE_DISTANCE_M) return null;
  return routeDistanceM / moving / WALK_M_PER_MIN;
}

export function updateSpeedFactor(current: number, sample: number): number {
  return clamp(ema(current, sample), SPEED_FACTOR_RANGE);
}

/**
 * Time spent at a group: from the visit until the first observation outside the radius,
 * minus the time needed to walk to that observation.
 */
export function dwellSample(visitedAt: Date, leftAt: Date, travelMinutes: number): number | null {
  const total = (leftAt.getTime() - visitedAt.getTime()) / 60_000;
  if (total < 0 || total > MAX_DWELL_SAMPLE_MIN) return null;
  return Math.max(0, total - travelMinutes);
}

export function updateDwell(current: number, sample: number): number {
  return clamp(ema(current, sample), DWELL_RANGE);
}

/**
 * One gradient-ascent step on the log-likelihood of the actual group:
 * w ← w + 0.1 · (term(actual) − Σ p_i · term(candidate_i)), then clamp to 0–2.
 */
export function updateWeights(weights: Weights, snapshot: SnapshotCandidate[], actualTeamApiId: number): Weights {
  const actual = snapshot.find((candidate) => candidate.teamApiId === actualTeamApiId);
  if (!actual) return weights;
  const next = { ...weights };
  for (const [weightKey, termKey] of TERM_KEYS) {
    const expected = snapshot.reduce((sum, candidate) => sum + candidate.probability * candidate.terms[termKey], 0);
    next[weightKey] = clamp(weights[weightKey] + WEIGHT_STEP * (actual.terms[termKey] - expected), WEIGHT_RANGE);
  }
  return next;
}

/** Count a top-1 / top-3 hit for the actual group. */
export function evaluateSnapshot(accuracy: Accuracy, snapshot: SnapshotCandidate[], actualTeamApiId: number): Accuracy {
  const ranked = [...snapshot].sort((a, b) => b.probability - a.probability);
  const rank = ranked.findIndex((candidate) => candidate.teamApiId === actualTeamApiId);
  return {
    top1Hits: accuracy.top1Hits + (rank === 0 ? 1 : 0),
    top3Hits: accuracy.top3Hits + (rank >= 0 && rank < TOP_CANDIDATES ? 1 : 0),
    evaluations: accuracy.evaluations + 1,
  };
}
```

- [ ] **Step 4: Run** `bun_ test src/services/prediction/learning.test.ts` → PASS.

- [ ] **Step 5: Routing interfaces** — `src/services/prediction/routing.ts` (types only; exercised by the tests below and in Task 4)

```ts
import type { LngLat, PolygonGeometry } from "./types";

/** ORS (or any walking router) could not answer: no key, HTTP error, quota. Callers fall back to estimates. */
export class RoutingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingUnavailableError";
  }
}

/** Transitous could not answer. Callers continue with walking only. */
export class TransitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitUnavailableError";
  }
}

export interface MatrixResult {
  /** durationsS[source][destination] in seconds; null when unreachable */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
}

export interface RouteResult {
  line: LngLat[];
  distanceM: number;
  durationS: number;
}

export interface WalkingRouter {
  matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult>;
  route(a: LngLat, b: LngLat): Promise<RouteResult>;
  /** Walking isochrones keyed by range in minutes */
  isochrones(center: LngLat, rangesMin: number[]): Promise<Record<number, PolygonGeometry>>;
}

export interface TransitPlace {
  name: string;
  lng: number;
  lat: number;
  arrival: Date | null;
  departure: Date | null;
}

export interface TransitLeg {
  /** Transitous mode, e.g. WALK, BUS, TRAM, REGIONAL_RAIL */
  mode: string;
  from: TransitPlace;
  to: TransitPlace;
  /** Line name shown to travellers (e.g. "80", "Intercity") */
  line: string | null;
}

export interface TransitItinerary {
  startTime: Date;
  endTime: Date;
  legs: TransitLeg[];
}

export interface TransitPlanner {
  /** Fastest itinerary departing at departAt, or null when none exists. Throws TransitUnavailableError. */
  plan(from: LngLat, to: LngLat, departAt: Date): Promise<TransitItinerary | null>;
}

export type StopKind = "train" | "tram" | "bus" | "other";

export interface StopInput {
  osmId: number;
  name: string;
  kind: StopKind;
  lng: number;
  lat: number;
}

export type Bbox = [west: number, south: number, east: number, north: number];

export interface StopSource {
  fetchStops(bbox: Bbox): Promise<StopInput[]>;
}
```

- [ ] **Step 6: Write the failing zones, transit and straight-line tests**

`src/services/prediction/zones.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { distanceM, moveM } from "./geo";
import type { LngLat } from "./types";
import { circleZone, elapsedMinutes, pickRing, walkRadiusM, zoneRanges } from "./zones";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe("zones", () => {
  test("elapsed = now − last observation − dwell, within 0–120", () => {
    expect(elapsedMinutes(at(50), at(0), 15)).toBe(35);
    expect(elapsedMinutes(at(300), at(0), 15)).toBe(120);
    expect(elapsedMinutes(at(10), at(0), 15)).toBe(0);
  });

  test("zone ranges use 10-minute buckets and the speed factor", () => {
    expect(zoneRanges(35, 1)).toEqual({ outerMin: 40, coreMin: 20 });
    expect(zoneRanges(0, 1)).toEqual({ outerMin: 10, coreMin: 5 });
    expect(zoneRanges(35, 1.6)).toEqual({ outerMin: 60, coreMin: 30 });
    expect(zoneRanges(120, 1.6)).toEqual({ outerMin: 200, coreMin: 100 });
  });

  test("walking radius = minutes × 5 km/h ÷ 1.3", () => {
    expect(walkRadiusM(13)).toBeCloseTo(833.33, 1);
    const ring = circleZone(O, 13).coordinates[0];
    expect(distanceM(O, ring[0] as LngLat)).toBeCloseTo(833.33, -1);
  });

  test("pickRing prefers the routed ring and falls back to a circle", () => {
    const routed = circleZone(moveM(O, 5000, 0), 1);
    expect(pickRing({ 10: routed }, O, 10)).toBe(routed);
    const fallback = pickRing({ 10: routed }, O, 70);
    expect(fallback.type).toBe("Polygon");
    expect(distanceM(O, fallback.coordinates[0][0] as LngLat)).toBeCloseTo(walkRadiusM(70), -1);
    expect(pickRing(undefined, O, 10).type).toBe("Polygon");
  });
});
```

`src/services/prediction/transit.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { TransitItinerary, TransitLeg, TransitPlace } from "./routing";
import { alightingStops, chooseTravel, isTransitMode, selectIslands, transitLabel, type IslandStop } from "./transit";

const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const place = (name: string, lng: number, arrival: Date | null = null): TransitPlace => ({ name, lng, lat: 52, arrival, departure: null });
const leg = (mode: string, to: TransitPlace, line: string | null = null): TransitLeg => ({ mode, from: place("x", 5), to, line });

function itinerary(legs: TransitLeg[], endMinutes: number): TransitItinerary {
  return { startTime: at(15), endTime: at(endMinutes), legs };
}

describe("isTransitMode", () => {
  test("oscar, orange status or a nearby stop", () => {
    expect(isTransitMode({ area: "oscar", status: "green", nearestStopDistanceM: Infinity })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "orange", nearestStopDistanceM: Infinity })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "green", nearestStopDistanceM: 249 })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "green", nearestStopDistanceM: 251 })).toBe(false);
  });
});

describe("transitLabel", () => {
  test("names the ridden lines in order", () => {
    const trip = itinerary(
      [leg("WALK", place("Kerk", 5.1)), leg("BUS", place("De Klomp", 5.2), "80"), leg("REGIONAL_RAIL", place("Utrecht Centraal", 5.3), "Intercity"), leg("WALK", place("END", 5.4))],
      100,
    );
    expect(transitLabel(trip)).toBe("bus 80 → trein Intercity");
  });

  test("null for walking-only itineraries", () => {
    expect(transitLabel(itinerary([leg("WALK", place("END", 5.4))], 60))).toBeNull();
  });
});

describe("chooseTravel", () => {
  const departAt = at(15);
  const bus = itinerary([leg("WALK", place("A", 5.1)), leg("BUS", place("B", 5.2, at(45)), "80"), leg("WALK", place("END", 5.3))], 55);

  test("transit when faster than walking", () => {
    expect(chooseTravel(60, bus, departAt)).toEqual({ travelMinutes: 40, via: "transit", transitLabel: "bus 80" });
  });

  test("walking when faster, when there is no itinerary or when it is walking-only", () => {
    expect(chooseTravel(30, bus, departAt)).toEqual({ travelMinutes: 30, via: "walk" });
    expect(chooseTravel(60, null, departAt)).toEqual({ travelMinutes: 60, via: "walk" });
    expect(chooseTravel(60, itinerary([leg("WALK", place("END", 5.4))], 40), departAt)).toEqual({ travelMinutes: 60, via: "walk" });
  });
});

describe("islands", () => {
  test("alighting stops are the destinations of ridden legs", () => {
    const trip = itinerary([leg("WALK", place("A", 5.1, at(20))), leg("BUS", place("B", 5.2, at(45)), "80"), leg("WALK", place("END", 5.3, at(55)))], 55);
    expect(alightingStops([trip])).toEqual([{ name: "B", lng: 5.2, lat: 52, arrival: at(45) }]);
  });

  test("reached stops only, largest remaining time first, deduplicated, at most 3", () => {
    const stops: IslandStop[] = [
      { name: "A", lng: 5.1, lat: 52, arrival: at(30) },
      { name: "B", lng: 5.2, lat: 52, arrival: at(50) },
      { name: "B again", lng: 5.2, lat: 52, arrival: at(40) },
      { name: "C", lng: 5.3, lat: 52, arrival: at(55) },
      { name: "D", lng: 5.4, lat: 52, arrival: at(58) },
      { name: "Future", lng: 5.5, lat: 52, arrival: at(80) },
    ];
    const islands = selectIslands(stops, at(60));
    expect(islands.map((island) => [island.stop.name, island.remainingMinutes])).toEqual([
      ["A", 30],
      ["B again", 20],
      ["C", 5],
    ]);
  });
});
```

`src/services/prediction/straight-line.router.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { distanceM, moveM } from "./geo";
import { straightLineRouter, straightLineSeconds } from "./straight-line.router";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];
const east = moveM(O, 1000, 0);

describe("straightLineRouter", () => {
  test("1 km straight = 1.3 km walking = 15.6 minutes at 5 km/h", async () => {
    expect(straightLineSeconds(O, east)).toBeCloseTo(936, -1);
    const matrix = await straightLineRouter.matrix([O], [east, O]);
    expect(matrix.durationsS[0][0]).toBeCloseTo(936, -1);
    expect(matrix.durationsS[0][1]).toBe(0);
    expect(matrix.distancesM[0][0]).toBeCloseTo(1300, -1);
  });

  test("route is the straight segment", async () => {
    const route = await straightLineRouter.route(O, east);
    expect(route.line).toEqual([O, east]);
    expect(route.distanceM).toBeCloseTo(1300, -1);
  });

  test("isochrones are circles keyed by minutes", async () => {
    const rings = await straightLineRouter.isochrones(O, [5, 10]);
    expect(Object.keys(rings).map(Number)).toEqual([5, 10]);
    expect(distanceM(O, rings[10].coordinates[0][0] as LngLat)).toBeCloseTo(641, -1);
  });
});
```

- [ ] **Step 7: Run** `bun_ test src/services/prediction/zones.test.ts src/services/prediction/transit.test.ts src/services/prediction/straight-line.router.test.ts` → FAIL (modules not found).

- [ ] **Step 8: Implement** — `src/services/prediction/zones.ts`

```ts
import { DETOUR_FACTOR, ELAPSED_CAP_MIN, WALK_M_PER_MIN } from "./constants";
import { circlePolygon } from "./geo";
import { clamp } from "./learning";
import type { LngLat, PolygonGeometry } from "./types";

/** Isochrone ranges requested once per position (ORS allows at most 10 ranges per call). */
export const ISOCHRONE_RANGES_MIN = [5, 10, 15, 20, 25, 30, 40, 50, 60];
const ZONE_BUCKET_MIN = 10;

/** Minutes the team has been able to walk since leaving the last observed position. */
export function elapsedMinutes(now: Date, lastTime: Date, dwellMinutes: number): number {
  return clamp((now.getTime() - lastTime.getTime()) / 60_000 - dwellMinutes, [0, ELAPSED_CAP_MIN]);
}

/** Outer/core zone ranges in walking minutes, rounded up to 10-minute buckets. */
export function zoneRanges(elapsed: number, speedFactor: number): { outerMin: number; coreMin: number } {
  const outerMin = Math.max(ZONE_BUCKET_MIN, Math.ceil((elapsed * speedFactor) / ZONE_BUCKET_MIN) * ZONE_BUCKET_MIN);
  return { outerMin, coreMin: outerMin / 2 };
}

/** Straight-line radius reachable in the given walking minutes (5 km/h over a 1.3× detour). */
export function walkRadiusM(walkMinutes: number): number {
  return (walkMinutes * WALK_M_PER_MIN) / DETOUR_FACTOR;
}

export function circleZone(center: LngLat, walkMinutes: number): PolygonGeometry {
  return circlePolygon(center, walkRadiusM(walkMinutes));
}

/** The routed isochrone for these minutes, or a circle when there is none. */
export function pickRing(rings: Record<number, PolygonGeometry> | undefined, center: LngLat, minutes: number): PolygonGeometry {
  return rings?.[minutes] ?? circleZone(center, minutes);
}
```

`src/services/prediction/transit.ts`

```ts
import { ELAPSED_CAP_MIN, MAX_ISLANDS, STOP_RADIUS_M } from "./constants";
import type { TransitItinerary } from "./routing";

export interface TravelChoice {
  travelMinutes: number;
  via: "walk" | "transit";
  transitLabel?: string;
}

export interface IslandStop {
  name: string;
  lng: number;
  lat: number;
  arrival: Date;
}

/** Public-transport mode: last observation near a stop, status orange, or area oscar (always). */
export function isTransitMode({ area, status, nearestStopDistanceM }: { area: string; status: string; nearestStopDistanceM: number }): boolean {
  return area.toLowerCase() === "oscar" || status === "orange" || nearestStopDistanceM < STOP_RADIUS_M;
}

/** Dutch name for a Transitous mode. */
export function transitKind(mode: string): string {
  if (mode === "SUBWAY" || mode === "METRO") return "metro";
  if (mode.includes("RAIL") || mode === "TRAIN") return "trein";
  if (mode === "TRAM") return "tram";
  if (mode === "FERRY") return "boot";
  if (mode === "BUS" || mode === "COACH") return "bus";
  return "ov";
}

/** "bus 80 → trein Intercity", or null when nothing is ridden. */
export function transitLabel(itinerary: TransitItinerary): string | null {
  const rides = itinerary.legs.filter((leg) => leg.mode !== "WALK");
  if (rides.length === 0) return null;
  return rides.map((leg) => `${transitKind(leg.mode)}${leg.line ? ` ${leg.line}` : ""}`).join(" → ");
}

/** Minutes from the planned departure until arrival (includes waiting for the first vehicle). */
export function transitMinutes(itinerary: TransitItinerary, departAt: Date): number {
  return (new Date(itinerary.endTime).getTime() - departAt.getTime()) / 60_000;
}

/** min(walking, public transport). */
export function chooseTravel(walkMinutes: number, itinerary: TransitItinerary | null, departAt: Date): TravelChoice {
  const walk: TravelChoice = { travelMinutes: walkMinutes, via: "walk" };
  if (!itinerary) return walk;
  const label = transitLabel(itinerary);
  if (!label) return walk;
  const minutes = transitMinutes(itinerary, departAt);
  return minutes < walkMinutes ? { travelMinutes: minutes, via: "transit", transitLabel: label } : walk;
}

/** Stops where the team gets off a vehicle in the fetched itineraries. */
export function alightingStops(itineraries: TransitItinerary[]): IslandStop[] {
  return itineraries.flatMap((itinerary) =>
    itinerary.legs
      .filter((leg) => leg.mode !== "WALK" && leg.to.arrival)
      .map((leg) => ({ name: leg.to.name, lng: leg.to.lng, lat: leg.to.lat, arrival: new Date(leg.to.arrival as Date) })),
  );
}

/** Reached stops (arrival ≤ now), one per location, largest remaining time first, at most `max`. */
export function selectIslands(stops: IslandStop[], now: Date, max = MAX_ISLANDS): { stop: IslandStop; remainingMinutes: number }[] {
  const best = new Map<string, { stop: IslandStop; remainingMinutes: number }>();
  for (const stop of stops) {
    const remaining = (now.getTime() - stop.arrival.getTime()) / 60_000;
    if (remaining < 0) continue;
    const key = `${stop.lng.toFixed(5)},${stop.lat.toFixed(5)}`;
    const entry = { stop, remainingMinutes: Math.min(remaining, ELAPSED_CAP_MIN) };
    const existing = best.get(key);
    if (!existing || existing.remainingMinutes < entry.remainingMinutes) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => b.remainingMinutes - a.remainingMinutes).slice(0, max);
}
```

`src/services/prediction/straight-line.router.ts`

```ts
import { DETOUR_FACTOR, WALK_M_PER_MIN } from "./constants";
import { distanceM } from "./geo";
import type { WalkingRouter } from "./routing";
import type { LngLat, PolygonGeometry } from "./types";
import { circleZone } from "./zones";

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
  async route(a, b) {
    return { line: [a, b], distanceM: distanceM(a, b) * DETOUR_FACTOR, durationS: straightLineSeconds(a, b) };
  },
  async isochrones(center, rangesMin) {
    const rings: Record<number, PolygonGeometry> = {};
    for (const minutes of rangesMin) rings[minutes] = circleZone(center, minutes);
    return rings;
  },
};
```

- [ ] **Step 9: Run tests and static checks**

Run: `bun_ test src/services/prediction/` → all PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 10: Commit**

```bash
git add src/services/prediction/learning.ts src/services/prediction/learning.test.ts src/services/prediction/zones.ts src/services/prediction/zones.test.ts src/services/prediction/routing.ts src/services/prediction/transit.ts src/services/prediction/transit.test.ts src/services/prediction/straight-line.router.ts src/services/prediction/straight-line.router.test.ts
git commit -m "feat(prediction): add learning, zones, transit maths and straight-line fallback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: ORS, Transitous and Overpass clients (server)

**Files:**
- Create: `src/services/prediction/http.ts`, `src/services/prediction/ors.client.ts`, `src/services/prediction/transitous.client.ts`, `src/services/prediction/overpass.client.ts`
- Test: `src/services/prediction/http.test.ts`, `src/services/prediction/ors.client.test.ts`, `src/services/prediction/transitous.client.test.ts`, `src/services/prediction/overpass.client.test.ts`

**Interfaces:**
- Consumes: `USER_AGENT` (Task 1); `WalkingRouter`, `MatrixResult`, `RouteResult`, `TransitPlanner`, `TransitItinerary`, `TransitPlace`, `StopSource`, `StopInput`, `StopKind`, `Bbox`, `RoutingUnavailableError`, `TransitUnavailableError` (Task 3).
- Produces:
  - http: `type Schedule = <T>(task: () => Promise<T>) => Promise<T>`, `type HttpPost = (url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => Promise<{ data: unknown }>`, `type HttpGet = (url: string, config: { params: Record<string, string>; headers: Record<string, string>; timeout: number }) => Promise<{ data: unknown }>`, `createThrottle(minIntervalMs: number, clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> }): Schedule`, `class DailyCounter { constructor(limit: number, now?: () => Date); tryConsume(): boolean }`
  - ORS: `ORS_BASE_URL`, `ORS_DAILY_LIMITS = { matrix: 500, directions: 2000, isochrones: 500 }`, `parseOrsMatrix(data): MatrixResult`, `parseOrsRoute(data): RouteResult`, `parseOrsIsochrones(data): Record<number, PolygonGeometry>`, `createOrsRouter(apiKey: string | undefined, deps?: { post?: HttpPost; schedule?: Schedule; counters?: Record<"matrix" | "directions" | "isochrones", DailyCounter> }): WalkingRouter`
  - Transitous: `TRANSITOUS_PLAN_URL`, `parseTransitousPlan(data): TransitItinerary | null`, `createTransitousPlanner(deps?: { get?: HttpGet; schedule?: Schedule }): TransitPlanner`
  - Overpass: `OVERPASS_URLS`, `buildOverpassQuery(bbox: Bbox): string`, `stopKind(tags: Record<string, string>): StopKind`, `parseOverpassStops(data): StopInput[]`, `createOverpassSource(deps?: { post?: HttpPost; urls?: string[]; schedule?: Schedule }): StopSource`

Endpoint shapes used (ORS from its v2 API docs — needs a key, so not probed; Transitous and Overpass probed with curl on 2026-09-27):
- ORS matrix: `POST https://api.openrouteservice.org/v2/matrix/foot-walking`, body `{ locations: [[lng,lat],…], sources: [i…], destinations: [j…], metrics: ["duration","distance"], units: "m" }` → `{ durations: number|null[][], distances: number|null[][], … }` (seconds / metres).
- ORS directions: `POST /v2/directions/foot-walking/geojson`, body `{ coordinates: [[lng,lat],[lng,lat]] }` → GeoJSON `FeatureCollection`, `features[0].geometry` `LineString`, `features[0].properties.summary { distance, duration }`.
- ORS isochrones: `POST /v2/isochrones/foot-walking`, body `{ locations: [[lng,lat]], range: [seconds…], range_type: "time" }` → `FeatureCollection` of `Polygon` features with `properties.value` = range in seconds.
- Transitous: `GET https://api.transitous.org/api/v5/plan?fromPlace=lat,lon&toPlace=lat,lon&time=ISO` → `{ itineraries: [{ startTime, endTime, duration, legs: [{ mode, from: { name, lat, lon, departure?, arrival? }, to: {…}, routeShortName?, displayName? }] }], direct: [...] }`.
- Overpass: `POST https://overpass-api.de/api/interpreter` form field `data` → `{ elements: [{ type: "node", id, lat, lon, tags }] }` (the main instance returned 504 "too busy" during probing; `https://overpass.private.coffee/api/interpreter` answered, hence the mirror fallback).

- [ ] **Step 1: Write the failing http test** — `src/services/prediction/http.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createThrottle, DailyCounter } from "./http";

describe("createThrottle", () => {
  test("spaces task starts by the interval and keeps order", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const order: number[] = [];
    const schedule = createThrottle(1000, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([1, 2, 3].map((n) => schedule(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  test("a failing task does not block the next one", async () => {
    const schedule = createThrottle(0);
    await expect(schedule(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await schedule(async () => 42)).toBe(42);
  });
});

describe("DailyCounter", () => {
  test("allows `limit` calls per UTC day", () => {
    let now = new Date("2026-10-17T10:00:00Z");
    const counter = new DailyCounter(2, () => now);
    expect([counter.tryConsume(), counter.tryConsume(), counter.tryConsume()]).toEqual([true, true, false]);
    now = new Date("2026-10-18T00:00:01Z");
    expect(counter.tryConsume()).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `bun_ test src/services/prediction/http.test.ts` → FAIL (`Cannot find module './http'`).

- [ ] **Step 3: Implement** — `src/services/prediction/http.ts`

```ts
export type Schedule = <T>(task: () => Promise<T>) => Promise<T>;

export type HttpPost = (url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => Promise<{ data: unknown }>;

export type HttpGet = (
  url: string,
  config: { params: Record<string, string>; headers: Record<string, string>; timeout: number },
) => Promise<{ data: unknown }>;

export interface ThrottleClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run tasks one after another with at least minIntervalMs between their starts.
 * Failed tasks reject their own promise but never block the queue.
 */
export function createThrottle(minIntervalMs: number, clock: ThrottleClock = {}): Schedule {
  const now = clock.now ?? (() => Date.now());
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return task();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/** Counts calls per UTC day and refuses once the daily limit is reached. */
export class DailyCounter {
  private day = "";
  private count = 0;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(limit: number, now: () => Date = () => new Date()) {
    this.limit = limit;
    this.now = now;
  }

  tryConsume(): boolean {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}
```

- [ ] **Step 4: Run** `bun_ test src/services/prediction/http.test.ts` → PASS.

- [ ] **Step 5: Write the failing client tests**

`src/services/prediction/ors.client.test.ts`

```ts
import { describe, expect, mock, test } from "bun:test";
import { USER_AGENT } from "./constants";
import { DailyCounter, type HttpPost } from "./http";
import { createOrsRouter, parseOrsIsochrones, parseOrsMatrix, parseOrsRoute } from "./ors.client";
import { RoutingUnavailableError } from "./routing";

const sampleMatrix = {
  durations: [[0, 720.5, null]],
  distances: [[0, 1000.2, null]],
  sources: [{ location: [5.48, 52.08] }],
  destinations: [{ location: [5.48, 52.08] }, { location: [5.49, 52.08] }, { location: [5.5, 52.09] }],
};
const sampleRoute = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { summary: { distance: 1234.5, duration: 888.8 } },
      geometry: { type: "LineString", coordinates: [[5.48, 52.08], [5.485, 52.081], [5.49, 52.081]] },
    },
  ],
};
const ring = [[[5.48, 52.08], [5.49, 52.08], [5.49, 52.09], [5.48, 52.08]]];
const sampleIsochrones = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { group_index: 0, value: 600, center: [5.48, 52.08] }, geometry: { type: "Polygon", coordinates: ring } },
    { type: "Feature", properties: { group_index: 0, value: 1200, center: [5.48, 52.08] }, geometry: { type: "Polygon", coordinates: ring } },
  ],
};

const immediate = <T>(task: () => Promise<T>) => task();

describe("ORS parsers", () => {
  test("matrix", () => {
    expect(parseOrsMatrix(sampleMatrix)).toEqual({ durationsS: [[0, 720.5, null]], distancesM: [[0, 1000.2, null]] });
    expect(() => parseOrsMatrix({})).toThrow(RoutingUnavailableError);
  });

  test("directions", () => {
    const route = parseOrsRoute(sampleRoute);
    expect(route.line).toHaveLength(3);
    expect(route.distanceM).toBe(1234.5);
    expect(route.durationS).toBe(888.8);
    expect(() => parseOrsRoute({ features: [] })).toThrow(RoutingUnavailableError);
  });

  test("isochrones keyed by minutes", () => {
    const rings = parseOrsIsochrones(sampleIsochrones);
    expect(Object.keys(rings).map(Number)).toEqual([10, 20]);
    expect(rings[10]).toEqual({ type: "Polygon", coordinates: ring });
  });
});

describe("createOrsRouter", () => {
  test("rejects without an API key and never calls out", async () => {
    const post = mock<HttpPost>(async () => ({ data: sampleMatrix }));
    const router = createOrsRouter(undefined, { post, schedule: immediate });
    await expect(router.matrix([[5.48, 52.08]], [[5.49, 52.08]])).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(post).not.toHaveBeenCalled();
  });

  test("sends the matrix request with the key and user agent", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (url, body, config) => {
      calls.push({ url, body, headers: config.headers });
      return { data: sampleMatrix };
    };
    const router = createOrsRouter("secret", { post, schedule: immediate });
    const result = await router.matrix([[5.48, 52.08]], [[5.48, 52.08], [5.49, 52.08], [5.5, 52.09]]);
    expect(calls[0].url).toBe("https://api.openrouteservice.org/v2/matrix/foot-walking");
    expect(calls[0].body).toEqual({
      locations: [[5.48, 52.08], [5.48, 52.08], [5.49, 52.08], [5.5, 52.09]],
      sources: [0],
      destinations: [1, 2, 3],
      metrics: ["duration", "distance"],
      units: "m",
    });
    expect(calls[0].headers.Authorization).toBe("secret");
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(result.durationsS[0][1]).toBe(720.5);
  });

  test("requests directions and isochrones", async () => {
    const bodies: Record<string, unknown> = {};
    const post: HttpPost = async (url, body) => {
      bodies[url] = body;
      return { data: url.includes("isochrones") ? sampleIsochrones : sampleRoute };
    };
    const router = createOrsRouter("secret", { post, schedule: immediate });
    await router.route([5.48, 52.08], [5.49, 52.081]);
    await router.isochrones([5.48, 52.08], [10, 20]);
    expect(bodies["https://api.openrouteservice.org/v2/directions/foot-walking/geojson"]).toEqual({ coordinates: [[5.48, 52.08], [5.49, 52.081]] });
    expect(bodies["https://api.openrouteservice.org/v2/isochrones/foot-walking"]).toEqual({ locations: [[5.48, 52.08]], range: [600, 1200], range_type: "time" });
  });

  test("HTTP errors and exhausted quota become RoutingUnavailableError", async () => {
    const failing = createOrsRouter("secret", { post: async () => Promise.reject(new Error("403")), schedule: immediate });
    await expect(failing.route([5.48, 52.08], [5.49, 52.08])).rejects.toBeInstanceOf(RoutingUnavailableError);

    const post = mock<HttpPost>(async () => ({ data: sampleRoute }));
    const exhausted = createOrsRouter("secret", {
      post,
      schedule: immediate,
      counters: { matrix: new DailyCounter(0), directions: new DailyCounter(0), isochrones: new DailyCounter(0) },
    });
    await expect(exhausted.route([5.48, 52.08], [5.49, 52.08])).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(post).not.toHaveBeenCalled();
  });
});
```

`src/services/prediction/transitous.client.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { USER_AGENT } from "./constants";
import type { HttpGet } from "./http";
import { TransitUnavailableError } from "./routing";
import { createTransitousPlanner, parseTransitousPlan } from "./transitous.client";

// Trimmed from a real response (Scherpenzeel → Utrecht, probed 2026-09-27)
const sample = {
  itineraries: [
    {
      duration: 4800,
      startTime: "2026-09-28T10:22:00Z",
      endTime: "2026-09-28T11:42:00Z",
      transfers: 1,
      legs: [
        {
          mode: "WALK",
          from: { name: "START", lat: 52.0806, lon: 5.4866, departure: "2026-09-28T10:22:00Z" },
          to: { name: "Scherpenzeel, Kerk", lat: 52.079647, lon: 5.487466, arrival: "2026-09-28T10:25:00Z" },
        },
        {
          mode: "BUS",
          from: { name: "Scherpenzeel, Kerk", lat: 52.079647, lon: 5.487466, departure: "2026-09-28T10:25:00Z" },
          to: { name: "De Klomp, Stat. Veenendaal-De Klomp", lat: 52.046036, lon: 5.573803, arrival: "2026-09-28T10:39:00Z" },
          routeShortName: "80",
          displayName: "80",
          headsign: "Veenendaal",
        },
        {
          mode: "REGIONAL_RAIL",
          from: { name: "Veenendaal-De Klomp", lat: 52.045963, lon: 5.5734963, departure: "2026-09-28T11:07:00Z" },
          to: { name: "Utrecht Centraal", lat: 52.09009, lon: 5.110244, arrival: "2026-09-28T11:26:00Z" },
          routeShortName: "Intercity",
          displayName: "Intercity",
        },
        {
          mode: "WALK",
          from: { name: "Utrecht Centraal", lat: 52.09009, lon: 5.110244, departure: "2026-09-28T11:26:00Z" },
          to: { name: "END", lat: 52.0907, lon: 5.1214, arrival: "2026-09-28T11:42:00Z" },
        },
      ],
    },
    {
      startTime: "2026-09-28T10:30:00Z",
      endTime: "2026-09-28T12:10:00Z",
      legs: [{ mode: "WALK", from: { name: "START", lat: 52.0806, lon: 5.4866 }, to: { name: "END", lat: 52.0907, lon: 5.1214 } }],
    },
  ],
  direct: [],
};

describe("parseTransitousPlan", () => {
  test("picks the earliest arrival and maps legs", () => {
    const itinerary = parseTransitousPlan(sample)!;
    expect(itinerary.endTime).toEqual(new Date("2026-09-28T11:42:00Z"));
    expect(itinerary.legs.map((leg) => [leg.mode, leg.line])).toEqual([
      ["WALK", null],
      ["BUS", "80"],
      ["REGIONAL_RAIL", "Intercity"],
      ["WALK", null],
    ]);
    expect(itinerary.legs[1].to).toEqual({
      name: "De Klomp, Stat. Veenendaal-De Klomp",
      lng: 5.573803,
      lat: 52.046036,
      arrival: new Date("2026-09-28T10:39:00Z"),
      departure: null,
    });
  });

  test("null when there are no itineraries, error on garbage", () => {
    expect(parseTransitousPlan({ itineraries: [], direct: [] })).toBeNull();
    expect(() => parseTransitousPlan("<html>")).toThrow(TransitUnavailableError);
  });
});

describe("createTransitousPlanner", () => {
  test("sends lat,lon places, ISO time and the user agent only", async () => {
    const calls: { url: string; params: Record<string, string>; headers: Record<string, string> }[] = [];
    const get: HttpGet = async (url, config) => {
      calls.push({ url, params: config.params, headers: config.headers });
      return { data: sample };
    };
    const planner = createTransitousPlanner({ get, schedule: (task) => task() });
    const itinerary = await planner.plan([5.4866, 52.0806], [5.1214, 52.0907], new Date("2026-09-28T10:00:00Z"));
    expect(itinerary?.legs).toHaveLength(4);
    expect(calls[0].url).toBe("https://api.transitous.org/api/v5/plan");
    expect(calls[0].params).toEqual({ fromPlace: "52.0806,5.4866", toPlace: "52.0907,5.1214", time: "2026-09-28T10:00:00.000Z" });
    expect(calls[0].headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json" });
  });

  test("network errors become TransitUnavailableError", async () => {
    const planner = createTransitousPlanner({ get: async () => Promise.reject(new Error("ECONNRESET")), schedule: (task) => task() });
    await expect(planner.plan([5.48, 52.08], [5.12, 52.09], new Date())).rejects.toBeInstanceOf(TransitUnavailableError);
  });
});
```

`src/services/prediction/overpass.client.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { USER_AGENT } from "./constants";
import type { HttpPost } from "./http";
import { buildOverpassQuery, createOverpassSource, parseOverpassStops, stopKind } from "./overpass.client";

const sample = {
  version: 0.6,
  elements: [
    { type: "node", id: 649245603, lat: 52.0802008, lon: 5.4740582, tags: { highway: "bus_stop", name: "Pluimenweg", public_transport: "platform" } },
    { type: "node", id: 42, lat: 52.0908, lon: 5.1102, tags: { railway: "station", name: "Utrecht Centraal" } },
    { type: "node", id: 43, lat: 52.09, lon: 5.12, tags: { railway: "tram_stop", public_transport: "platform" } },
    { type: "node", id: 42, lat: 52.0908, lon: 5.1102, tags: { railway: "station", name: "Utrecht Centraal" } },
    { type: "way", id: 7, tags: { railway: "station" } },
  ],
};

describe("overpass", () => {
  test("query covers platforms, stations and bus stops in the bbox (south,west,north,east)", () => {
    const query = buildOverpassQuery([5.1, 52.0, 5.6, 52.2]);
    expect(query).toBe(
      '[out:json][timeout:90];(node["public_transport"="platform"](52,5.1,52.2,5.6);node["railway"="station"](52,5.1,52.2,5.6);node["highway"="bus_stop"](52,5.1,52.2,5.6););out body;',
    );
  });

  test("stopKind", () => {
    expect(stopKind({ railway: "station" })).toBe("train");
    expect(stopKind({ public_transport: "platform", train: "yes" })).toBe("train");
    expect(stopKind({ railway: "tram_stop" })).toBe("tram");
    expect(stopKind({ highway: "bus_stop" })).toBe("bus");
    expect(stopKind({ public_transport: "platform" })).toBe("other");
  });

  test("parses nodes, deduplicates and names unnamed stops", () => {
    expect(parseOverpassStops(sample)).toEqual([
      { osmId: 649245603, name: "Pluimenweg", kind: "bus", lng: 5.4740582, lat: 52.0802008 },
      { osmId: 42, name: "Utrecht Centraal", kind: "train", lng: 5.1102, lat: 52.0908 },
      { osmId: 43, name: "Halte", kind: "tram", lng: 5.12, lat: 52.09 },
    ]);
  });

  test("falls back to the next URL and sends a form body with the user agent", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (url, body, config) => {
      calls.push({ url, body, headers: config.headers });
      if (url === "https://a.example/api/interpreter") throw new Error("504");
      return { data: sample };
    };
    const source = createOverpassSource({ post, urls: ["https://a.example/api/interpreter", "https://b.example/api/interpreter"], schedule: (task) => task() });
    const stops = await source.fetchStops([5.1, 52.0, 5.6, 52.2]);
    expect(stops).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual(["https://a.example/api/interpreter", "https://b.example/api/interpreter"]);
    expect(String(calls[1].body).startsWith("data=%5Bout%3Ajson%5D")).toBe(true);
    expect(calls[1].headers["User-Agent"]).toBe(USER_AGENT);
  });

  test("throws when every URL fails", async () => {
    const source = createOverpassSource({ post: async () => Promise.reject(new Error("504")), urls: ["https://a.example"], schedule: (task) => task() });
    await expect(source.fetchStops([5.1, 52.0, 5.6, 52.2])).rejects.toThrow("Overpass unavailable");
  });
});
```

- [ ] **Step 6: Run** `bun_ test src/services/prediction/ors.client.test.ts src/services/prediction/transitous.client.test.ts src/services/prediction/overpass.client.test.ts` → FAIL (modules not found).

- [ ] **Step 7: Implement** — `src/services/prediction/ors.client.ts`

```ts
import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, DailyCounter, type HttpPost, type Schedule } from "./http";
import { RoutingUnavailableError, type MatrixResult, type RouteResult, type WalkingRouter } from "./routing";
import type { LngLat, PolygonGeometry } from "./types";

export const ORS_BASE_URL = "https://api.openrouteservice.org/v2";
/** Free-plan daily quotas per endpoint; beyond these we fall back to estimates. */
export const ORS_DAILY_LIMITS = { matrix: 500, directions: 2000, isochrones: 500 } as const;
type OrsEndpoint = keyof typeof ORS_DAILY_LIMITS;

export interface OrsDeps {
  post?: HttpPost;
  schedule?: Schedule;
  counters?: Record<OrsEndpoint, DailyCounter>;
}

export function parseOrsMatrix(data: unknown): MatrixResult {
  const { durations, distances } = (data ?? {}) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
  if (!Array.isArray(durations) || !Array.isArray(distances)) throw new RoutingUnavailableError("ORS matrix: unexpected response");
  return { durationsS: durations, distancesM: distances };
}

export function parseOrsRoute(data: unknown): RouteResult {
  const features = (data as { features?: { geometry?: { coordinates?: LngLat[] }; properties?: { summary?: { distance?: number; duration?: number } } }[] })
    ?.features;
  const feature = Array.isArray(features) ? features[0] : undefined;
  const line = feature?.geometry?.coordinates;
  if (!Array.isArray(line) || line.length < 2) throw new RoutingUnavailableError("ORS directions: unexpected response");
  return { line, distanceM: feature?.properties?.summary?.distance ?? 0, durationS: feature?.properties?.summary?.duration ?? 0 };
}

export function parseOrsIsochrones(data: unknown): Record<number, PolygonGeometry> {
  const features = (data as { features?: { geometry?: PolygonGeometry; properties?: { value?: number } }[] })?.features;
  if (!Array.isArray(features)) throw new RoutingUnavailableError("ORS isochrones: unexpected response");
  const rings: Record<number, PolygonGeometry> = {};
  for (const feature of features) {
    const value = feature.properties?.value;
    if (feature.geometry?.type === "Polygon" && typeof value === "number") {
      rings[Math.round(value / 60)] = { type: "Polygon", coordinates: feature.geometry.coordinates };
    }
  }
  return rings;
}

/**
 * OpenRouteService foot-walking router. Every failure (no key, HTTP error, quota) is a
 * RoutingUnavailableError so the prediction service can fall back to estimates.
 */
export function createOrsRouter(apiKey: string | undefined, deps: OrsDeps = {}): WalkingRouter {
  const post: HttpPost = deps.post ?? ((url, body, config) => axios.post(url, body, config));
  const schedule = deps.schedule ?? createThrottle(1000);
  const counters = deps.counters ?? {
    matrix: new DailyCounter(ORS_DAILY_LIMITS.matrix),
    directions: new DailyCounter(ORS_DAILY_LIMITS.directions),
    isochrones: new DailyCounter(ORS_DAILY_LIMITS.isochrones),
  };

  async function call(endpoint: OrsEndpoint, path: string, body: unknown): Promise<unknown> {
    if (!apiKey) throw new RoutingUnavailableError("ORS_API_KEY is not set");
    return schedule(async () => {
      if (!counters[endpoint].tryConsume()) throw new RoutingUnavailableError(`ORS ${endpoint}: daily limit reached`);
      try {
        const response = await post(`${ORS_BASE_URL}${path}`, body, {
          headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
            Accept: "application/json, application/geo+json",
            "User-Agent": USER_AGENT,
          },
          timeout: 15_000,
        });
        return response.data;
      } catch (error) {
        throw new RoutingUnavailableError(`ORS ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return {
    async matrix(sources, destinations) {
      const data = await call("matrix", "/matrix/foot-walking", {
        locations: [...sources, ...destinations],
        sources: sources.map((_, index) => index),
        destinations: destinations.map((_, index) => sources.length + index),
        metrics: ["duration", "distance"],
        units: "m",
      });
      return parseOrsMatrix(data);
    },
    async route(a, b) {
      return parseOrsRoute(await call("directions", "/directions/foot-walking/geojson", { coordinates: [a, b] }));
    },
    async isochrones(center, rangesMin) {
      const data = await call("isochrones", "/isochrones/foot-walking", {
        locations: [center],
        range: rangesMin.map((minutes) => minutes * 60),
        range_type: "time",
      });
      return parseOrsIsochrones(data);
    },
  };
}
```

`src/services/prediction/transitous.client.ts`

```ts
import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, type HttpGet, type Schedule } from "./http";
import { TransitUnavailableError, type TransitItinerary, type TransitPlace, type TransitPlanner } from "./routing";

export const TRANSITOUS_PLAN_URL = "https://api.transitous.org/api/v5/plan";

interface RawPlace {
  name?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
}

interface RawLeg {
  mode?: string;
  from?: RawPlace;
  to?: RawPlace;
  displayName?: string;
  routeShortName?: string;
}

interface RawItinerary {
  startTime?: string;
  endTime?: string;
  legs?: RawLeg[];
}

function toPlace(raw: RawPlace | undefined): TransitPlace {
  return {
    name: raw?.name ?? "",
    lng: raw?.lon ?? 0,
    lat: raw?.lat ?? 0,
    arrival: raw?.arrival ? new Date(raw.arrival) : null,
    departure: raw?.departure ? new Date(raw.departure) : null,
  };
}

/** The itinerary that arrives first, or null when Transitous found none. */
export function parseTransitousPlan(data: unknown): TransitItinerary | null {
  const itineraries = (data as { itineraries?: RawItinerary[] } | null)?.itineraries;
  if (!Array.isArray(itineraries)) throw new TransitUnavailableError("Transitous: unexpected response");
  const parsed = itineraries
    .filter((itinerary) => itinerary.startTime && itinerary.endTime && Array.isArray(itinerary.legs) && itinerary.legs.length > 0)
    .map((itinerary) => ({
      startTime: new Date(itinerary.startTime as string),
      endTime: new Date(itinerary.endTime as string),
      legs: (itinerary.legs as RawLeg[]).map((leg) => ({
        mode: leg.mode ?? "WALK",
        from: toPlace(leg.from),
        to: toPlace(leg.to),
        line: leg.displayName || leg.routeShortName || null,
      })),
    }));
  parsed.sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
  return parsed[0] ?? null;
}

/** Transitous (MOTIS) journey planner. Sends only coordinates and a time. */
export function createTransitousPlanner(deps: { get?: HttpGet; schedule?: Schedule } = {}): TransitPlanner {
  const get: HttpGet = deps.get ?? ((url, config) => axios.get(url, config));
  const schedule = deps.schedule ?? createThrottle(1000);
  return {
    plan(from, to, departAt) {
      return schedule(async () => {
        let data: unknown;
        try {
          const response = await get(TRANSITOUS_PLAN_URL, {
            params: { fromPlace: `${from[1]},${from[0]}`, toPlace: `${to[1]},${to[0]}`, time: departAt.toISOString() },
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            timeout: 20_000,
          });
          data = response.data;
        } catch (error) {
          throw new TransitUnavailableError(`Transitous: ${error instanceof Error ? error.message : String(error)}`);
        }
        return parseTransitousPlan(data);
      });
    },
  };
}
```

`src/services/prediction/overpass.client.ts`

```ts
import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, type HttpPost, type Schedule } from "./http";
import type { Bbox, StopInput, StopKind, StopSource } from "./routing";

/** Main instance first, then a mirror (the main instance is often "too busy"). */
export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

interface RawElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

export function buildOverpassQuery([west, south, east, north]: Bbox): string {
  const box = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:90];(node["public_transport"="platform"]${box};node["railway"="station"]${box};node["highway"="bus_stop"]${box};);out body;`;
}

export function stopKind(tags: Record<string, string>): StopKind {
  if (tags.railway === "station" || tags.railway === "halt" || tags.train === "yes") return "train";
  if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
  if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
  return "other";
}

export function parseOverpassStops(data: unknown): StopInput[] {
  const elements = (data as { elements?: RawElement[] } | null)?.elements;
  if (!Array.isArray(elements)) throw new Error("Overpass: unexpected response");
  const stops = new Map<number, StopInput>();
  for (const element of elements) {
    if (element.type !== "node" || typeof element.id !== "number" || typeof element.lat !== "number" || typeof element.lon !== "number") continue;
    const tags = element.tags ?? {};
    stops.set(element.id, { osmId: element.id, name: tags.name ?? "Halte", kind: stopKind(tags), lng: element.lon, lat: element.lat });
  }
  return [...stops.values()];
}

/** Public-transport stops from OpenStreetMap via the Overpass API. */
export function createOverpassSource(deps: { post?: HttpPost; urls?: string[]; schedule?: Schedule } = {}): StopSource {
  const post: HttpPost = deps.post ?? ((url, body, config) => axios.post(url, body, config));
  const urls = deps.urls ?? OVERPASS_URLS;
  const schedule = deps.schedule ?? createThrottle(1000);
  return {
    async fetchStops(bbox) {
      const body = new URLSearchParams({ data: buildOverpassQuery(bbox) }).toString();
      let lastError: unknown;
      for (const url of urls) {
        try {
          const response = await schedule(() =>
            post(url, body, { headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT }, timeout: 120_000 }),
          );
          return parseOverpassStops(response.data);
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`Overpass unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    },
  };
}
```

- [ ] **Step 8: Run tests and static checks**

Run: `bun_ test src/services/prediction/` → all PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 9: Commit**

```bash
git add src/services/prediction/http.ts src/services/prediction/http.test.ts src/services/prediction/ors.client.ts src/services/prediction/ors.client.test.ts src/services/prediction/transitous.client.ts src/services/prediction/transitous.client.test.ts src/services/prediction/overpass.client.ts src/services/prediction/overpass.client.test.ts
git commit -m "feat(prediction): add throttled ORS, Transitous and Overpass clients

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: Models, routing cache, visit and transit-stop services (server)

**Files:**
- Create: `src/models/group-visit.model.ts`, `src/models/prediction-model.model.ts`, `src/models/prediction.model.ts`, `src/models/routing-cache.model.ts`, `src/models/transit-stop.model.ts`
- Create: `src/services/prediction/routing-cache.ts`, `src/services/prediction/visit.service.ts`, `src/services/prediction/transit-stop.service.ts`, `src/test/prediction-fixtures.ts`
- Test: `src/services/prediction/routing-cache.test.ts`, `src/services/prediction/visit.service.test.ts`, `src/services/prediction/transit-stop.service.test.ts`

**Interfaces:**
- Consumes: `AutoVisit`, `ManualVisit`, `VisitStateValue` (Task 2); `StopSource`, `Bbox` (Task 3); `distanceM`, `paddedBbox`, `moveM` (Task 1); existing `Team`, `Area`, `Marker` models, `connectTestDb`/`clearTestDb`/`disconnectTestDb` from `src/test/db.ts`.
- Produces:
  - Models: `GroupVisit` + enums `VisitState { Visited = "visited", NotVisited = "not_visited" }`, `VisitSource { Auto = "auto", Manual = "manual" }` (unique `{ teamApiId, round }`, timestamps); `PredictionModel` (learned params per area); `Prediction` (stored result per area: `area, status, mode, estimate, transitUnavailable, lastObservation, zone, candidates, accuracy, updatedAt, paused, reason?, round, snapshot, signature`); `RoutingCache` (`key` unique, `value` Mixed, `expiresAt` TTL); `TransitStop` (`osmId` unique, `name`, `kind`, `location` GeoJSON point with 2dsphere index).
  - `readCache<T>(key: string): Promise<T | undefined>`, `writeCache(key: string, value: unknown, ttlMs: number): Promise<void>`
  - `loadManualVisits(area: string): Promise<ManualVisit[]>`, `manualVisitsVersion(area: string): Promise<string>`, `replaceAutoVisits(area: string, visits: AutoVisit[]): Promise<void>`, `type VisitInput = "visited" | "not_visited" | "auto"`, `interface VisitDto { area: string; teamApiId: number; round: number; state: VisitStateValue; source: "auto" | "manual"; visitedAt: Date | null }`, `setManualVisit(teamApiId: number, state: VisitInput, now?: Date): Promise<{ area: string; visit: VisitDto } | null>`, `listCurrentVisits(): Promise<VisitDto[]>`
  - `refreshTransitStops(source: StopSource): Promise<number>`, `nearestStopDistanceM(position: LngLat): Promise<number>` (Infinity when there are no stops), `STOPS_PADDING_M = 10_000`
  - Fixtures: `makeTeam(apiId: number, area: string, location: LngLat, name?: string)`, `addObservation(area: string, time: Date, location: LngLat, type?: MarkerType)`, `setAreaStatus(name: string, status: "green" | "orange" | "red", updatedAt?: Date)`

- [ ] **Step 1: Models**

`src/models/group-visit.model.ts`

```ts
import mongoose from "mongoose";

export enum VisitState {
  Visited = "visited",
  NotVisited = "not_visited",
}

export enum VisitSource {
  Auto = "auto",
  Manual = "manual",
}

const GroupVisitSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, lowercase: true },
    teamApiId: { type: Number, required: true },
    round: { type: Number, required: true, min: 1 },
    state: { type: String, enum: Object.values(VisitState), required: true },
    source: { type: String, enum: Object.values(VisitSource), required: true },
    visitedAt: { type: Date, default: null },
    evidence: { type: String },
  },
  { timestamps: true },
);

GroupVisitSchema.index({ teamApiId: 1, round: 1 }, { unique: true });
GroupVisitSchema.index({ area: 1, source: 1 });

export const GroupVisit = mongoose.model("GroupVisit", GroupVisitSchema);
```

`src/models/prediction-model.model.ts`

```ts
import mongoose from "mongoose";

// Learned parameters per area (fox team). Defaults are the spec's start values.
const PredictionModelSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    speedFactor: { type: Number, default: 1 },
    dwellMinutes: { type: Number, default: 15 },
    weights: {
      wTime: { type: Number, default: 1 },
      wHeading: { type: Number, default: 0.5 },
      wTour: { type: Number, default: 0.7 },
      wCluster: { type: Number, default: 0.3 },
    },
    accuracy: {
      top1Hits: { type: Number, default: 0 },
      top3Hits: { type: Number, default: 0 },
      evaluations: { type: Number, default: 0 },
    },
    lastHintTime: { type: Date, default: null },
    lastDwellVisitAt: { type: Date, default: null },
    // { basedOn: Date, candidates: [{ teamApiId, probability, terms }] } waiting for the next visit
    pendingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false },
);

export const PredictionModel = mongoose.model("PredictionModel", PredictionModelSchema);
```

`src/models/prediction.model.ts`

```ts
import mongoose from "mongoose";

// The latest prediction per area, so GET /predictions is a plain read.
const PredictionSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, default: "unknown" },
    mode: { type: String, enum: ["walking", "transit"], default: "walking" },
    estimate: { type: Boolean, default: false },
    transitUnavailable: { type: Boolean, default: false },
    lastObservation: { type: mongoose.Schema.Types.Mixed, default: null },
    zone: { type: mongoose.Schema.Types.Mixed, default: () => ({ core: null, outer: null, islands: [] }) },
    candidates: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    accuracy: { type: mongoose.Schema.Types.Mixed, default: () => ({ top1Hits: 0, top3Hits: 0, evaluations: 0 }) },
    updatedAt: { type: Date, required: true },
    paused: { type: Boolean, default: false },
    reason: { type: String },
    round: { type: Number, default: 1 },
    // All candidates with their terms (for learning); not exposed by the API
    snapshot: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    // Inputs fingerprint; unchanged + younger than 5 minutes = no recompute
    signature: { type: String, default: "" },
  },
  { minimize: false },
);

export const Prediction = mongoose.model("Prediction", PredictionSchema);
```

`src/models/routing-cache.model.ts`

```ts
import mongoose from "mongoose";

const RoutingCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});

// MongoDB removes expired entries in the background; readCache also checks expiresAt
RoutingCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoutingCache = mongoose.model("RoutingCache", RoutingCacheSchema);
```

`src/models/transit-stop.model.ts`

```ts
import mongoose from "mongoose";

const TransitStopSchema = new mongoose.Schema({
  osmId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ["train", "tram", "bus", "other"], required: true },
  // Plain GeoJSON point (no sub-document _id) so the 2dsphere index accepts it
  location: {
    type: { type: String, enum: ["Point"], required: true },
    coordinates: { type: [Number], required: true },
  },
});

TransitStopSchema.index({ location: "2dsphere" });

export const TransitStop = mongoose.model("TransitStop", TransitStopSchema);
```

- [ ] **Step 2: Test fixtures** — `src/test/prediction-fixtures.ts`

```ts
import { Area } from "../models/area.model";
import { Marker, MarkerType } from "../models/marker.model";
import { Team } from "../models/team.model";
import type { LngLat } from "../services/prediction/types";

export async function makeTeam(apiId: number, area: string, [lng, lat]: LngLat, name = `Groep ${apiId}`) {
  return Team.create({
    apiId,
    name,
    accomodation: "Clubhuis",
    street: "Straat",
    houseNumber: 1,
    postCode: "1234AB",
    city: "Plaats",
    area,
    location: { type: "Point", coordinates: [lng, lat] },
  });
}

export async function addObservation(area: string, time: Date, [lng, lat]: LngLat, type: MarkerType = MarkerType.Hint) {
  return Marker.create({ area, time, type, location: { type: "Point", coordinates: [lng, lat] } });
}

export async function setAreaStatus(name: string, status: "green" | "orange" | "red", updatedAt = new Date()) {
  await Area.updateOne({ name }, { $set: { status, updatedAt } }, { upsert: true });
}
```

- [ ] **Step 3: Write the failing tests**

`src/services/prediction/routing-cache.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { readCache, writeCache } from "./routing-cache";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("routing cache", () => {
  test("returns written values until they expire", async () => {
    await writeCache("route:a>b", { line: [[5, 52], [5.1, 52]], distanceM: 1 }, 60_000);
    expect(await readCache<unknown>("route:a>b")).toEqual({ line: [[5, 52], [5.1, 52]], distanceM: 1 });
    await writeCache("route:a>b", { distanceM: 2 }, 60_000);
    expect(await readCache<unknown>("route:a>b")).toEqual({ distanceM: 2 });
    await writeCache("old", { distanceM: 3 }, -1);
    expect(await readCache("old")).toBeUndefined();
    expect(await readCache("missing")).toBeUndefined();
  });
});
```

`src/services/prediction/visit.service.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import type { LngLat } from "./types";
import { listCurrentVisits, loadManualVisits, manualVisitsVersion, replaceAutoVisits, setManualVisit } from "./visit.service";

const O: LngLat = [5.4866, 52.0806];
const T = new Date("2026-10-17T10:00:00.000Z");

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("GroupVisit", () => {
  test("one doc per (team, round)", async () => {
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Auto });
    await expect(GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Manual })).rejects.toThrow();
  });
});

describe("replaceAutoVisits", () => {
  test("replaces the area's auto visits and keeps manual ones", async () => {
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.NotVisited, source: VisitSource.Manual });
    await replaceAutoVisits("alpha", [{ teamApiId: 2, round: 1, visitedAt: T, evidence: "point" }]);
    await replaceAutoVisits("alpha", [{ teamApiId: 3, round: 1, visitedAt: T, evidence: "route" }]);
    const docs = await GroupVisit.find().sort({ teamApiId: 1 }).lean();
    expect(docs.map((doc) => [doc.teamApiId, doc.source, doc.evidence ?? null])).toEqual([
      [1, "manual", null],
      [3, "auto", "route"],
    ]);
  });
});

describe("setManualVisit", () => {
  test("overrides an auto visit; 'auto' removes the override", async () => {
    await makeTeam(7, "Alpha", O);
    await replaceAutoVisits("alpha", [{ teamApiId: 7, round: 1, visitedAt: T, evidence: "point" }]);
    const versionBefore = await manualVisitsVersion("alpha");

    const manual = await setManualVisit(7, "not_visited", T);
    expect(manual).toMatchObject({ area: "alpha", visit: { teamApiId: 7, round: 1, state: "not_visited", source: "manual", visitedAt: null } });
    expect(await loadManualVisits("alpha")).toEqual([{ teamApiId: 7, round: 1, state: "not_visited", visitedAt: null }]);
    expect(await manualVisitsVersion("alpha")).not.toBe(versionBefore);

    const reset = await setManualVisit(7, "auto", T);
    expect(reset?.visit).toEqual({ area: "alpha", teamApiId: 7, round: 1, state: "not_visited", source: "auto", visitedAt: null });
    expect(await loadManualVisits("alpha")).toEqual([]);
  });

  test("uses the current round stored on the prediction", async () => {
    await makeTeam(7, "alpha", O);
    await Prediction.create({ area: "alpha", round: 2, updatedAt: T });
    const result = await setManualVisit(7, "visited", T);
    expect(result?.visit).toMatchObject({ round: 2, state: "visited", source: "manual", visitedAt: T });
  });

  test("null for unknown teams or teams without an area", async () => {
    expect(await setManualVisit(999, "visited", T)).toBeNull();
    await makeTeam(8, "", O);
    expect(await setManualVisit(8, "visited", T)).toBeNull();
  });
});

describe("listCurrentVisits", () => {
  test("only visits of each area's current round", async () => {
    await Prediction.create({ area: "alpha", round: 2, updatedAt: T });
    await replaceAutoVisits("alpha", [
      { teamApiId: 1, round: 1, visitedAt: T, evidence: "point" },
      { teamApiId: 2, round: 2, visitedAt: T, evidence: "point" },
    ]);
    await replaceAutoVisits("bravo", [{ teamApiId: 3, round: 1, visitedAt: T, evidence: "route" }]);
    const visits = await listCurrentVisits();
    expect(visits.map((visit) => visit.teamApiId).sort()).toEqual([2, 3]);
    expect(visits.find((visit) => visit.teamApiId === 3)).toEqual({ area: "bravo", teamApiId: 3, round: 1, state: "visited", source: "auto", visitedAt: T });
  });
});
```

`src/services/prediction/transit-stop.service.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { TransitStop } from "../../models/transit-stop.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import { moveM } from "./geo";
import type { Bbox, StopSource } from "./routing";
import { nearestStopDistanceM, refreshTransitStops } from "./transit-stop.service";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("refreshTransitStops", () => {
  test("fetches stops around all groups (+10 km) and replaces the old ones", async () => {
    const far = moveM(O, 5000, 5000);
    await makeTeam(1, "alpha", O);
    await makeTeam(2, "bravo", far);
    await TransitStop.create({ osmId: 1, name: "Oud", kind: "bus", location: { type: "Point", coordinates: O } });
    let requested: Bbox | undefined;
    const source: StopSource = {
      fetchStops: async (bbox) => {
        requested = bbox;
        return [
          { osmId: 10, name: "Station", kind: "train", lng: O[0], lat: O[1] },
          { osmId: 11, name: "Kerk", kind: "bus", lng: 5.49, lat: 52.09 },
        ];
      },
    };
    expect(await refreshTransitStops(source)).toBe(2);
    const [west, south, east, north] = requested!;
    expect(west).toBeLessThan(moveM(O, -9000, 0)[0]);
    expect(south).toBeLessThan(moveM(O, 0, -9000)[1]);
    expect(east).toBeGreaterThan(moveM(far, 9000, 0)[0]);
    expect(north).toBeGreaterThan(moveM(far, 0, 9000)[1]);
    expect((await TransitStop.find().lean()).map((stop) => stop.name).sort()).toEqual(["Kerk", "Station"]);
  });

  test("an empty result keeps the existing stops", async () => {
    await makeTeam(1, "alpha", O);
    await TransitStop.create({ osmId: 1, name: "Oud", kind: "bus", location: { type: "Point", coordinates: O } });
    expect(await refreshTransitStops({ fetchStops: async () => [] })).toBe(0);
    expect(await TransitStop.countDocuments()).toBe(1);
  });

  test("does nothing without groups", async () => {
    const fetchStops = mock(async () => []);
    expect(await refreshTransitStops({ fetchStops })).toBe(0);
    expect(fetchStops).not.toHaveBeenCalled();
  });
});

describe("nearestStopDistanceM", () => {
  test("distance to the nearest stop, Infinity without stops", async () => {
    expect(await nearestStopDistanceM(O)).toBe(Infinity);
    await TransitStop.create({ osmId: 1, name: "Dichtbij", kind: "bus", location: { type: "Point", coordinates: moveM(O, 200, 0) } });
    await TransitStop.create({ osmId: 2, name: "Ver", kind: "train", location: { type: "Point", coordinates: moveM(O, 3000, 0) } });
    expect(await nearestStopDistanceM(O)).toBeCloseTo(200, -1);
  });
});
```

- [ ] **Step 4: Run** `bun_ test src/services/prediction/routing-cache.test.ts src/services/prediction/visit.service.test.ts src/services/prediction/transit-stop.service.test.ts` → FAIL (modules not found).

- [ ] **Step 5: Implement**

`src/services/prediction/routing-cache.ts`

```ts
import { RoutingCache } from "../../models/routing-cache.model";

/** A cached routing result, or undefined when missing or expired. */
export async function readCache<T>(key: string): Promise<T | undefined> {
  const entry = await RoutingCache.findOne({ key }).lean();
  if (!entry || entry.expiresAt.getTime() <= Date.now()) return undefined;
  return entry.value as T;
}

export async function writeCache(key: string, value: unknown, ttlMs: number): Promise<void> {
  await RoutingCache.updateOne({ key }, { $set: { value, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
}
```

`src/services/prediction/visit.service.ts`

```ts
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";
import type { AutoVisit, ManualVisit, VisitStateValue } from "./visits";

export type VisitInput = "visited" | "not_visited" | "auto";

export interface VisitDto {
  area: string;
  teamApiId: number;
  round: number;
  state: VisitStateValue;
  source: "auto" | "manual";
  visitedAt: Date | null;
}

interface VisitDoc {
  area: string;
  teamApiId: number;
  round: number;
  state: string;
  source: string;
  visitedAt?: Date | null;
}

function toDto(doc: VisitDoc): VisitDto {
  return {
    area: doc.area,
    teamApiId: doc.teamApiId,
    round: doc.round,
    state: doc.state as VisitStateValue,
    source: doc.source as "auto" | "manual",
    visitedAt: doc.visitedAt ?? null,
  };
}

async function currentRoundFor(area: string): Promise<number> {
  const prediction = await Prediction.findOne({ area }, { round: 1 }).lean();
  return prediction?.round ?? 1;
}

export async function loadManualVisits(area: string): Promise<ManualVisit[]> {
  const docs = await GroupVisit.find({ area, source: VisitSource.Manual }).sort({ teamApiId: 1, round: 1 }).lean();
  return docs.map((doc) => ({ teamApiId: doc.teamApiId, round: doc.round, state: doc.state as VisitStateValue, visitedAt: doc.visitedAt ?? null }));
}

/** Changes whenever a manual visit of the area is added, changed or removed. */
export async function manualVisitsVersion(area: string): Promise<string> {
  const [count, latest] = await Promise.all([
    GroupVisit.countDocuments({ area, source: VisitSource.Manual }),
    GroupVisit.findOne({ area, source: VisitSource.Manual }).sort({ updatedAt: -1 }).lean(),
  ]);
  return `${count}:${latest?.updatedAt?.toISOString() ?? ""}`;
}

/** Replace all auto visits of an area with a freshly computed set. Manual visits are left alone. */
export async function replaceAutoVisits(area: string, visits: AutoVisit[]): Promise<void> {
  await GroupVisit.deleteMany({ area, source: VisitSource.Auto });
  if (visits.length === 0) return;
  await GroupVisit.insertMany(
    visits.map((visit) => ({
      area,
      teamApiId: visit.teamApiId,
      round: visit.round,
      state: VisitState.Visited,
      source: VisitSource.Auto,
      visitedAt: visit.visitedAt,
      evidence: visit.evidence,
    })),
  );
}

/**
 * Set or clear a manual override for a group. `visited` / `not_visited` apply to the area's
 * current round; `auto` removes the team's newest manual override.
 * @returns null when the team is unknown or has no area
 */
export async function setManualVisit(teamApiId: number, state: VisitInput, now = new Date()): Promise<{ area: string; visit: VisitDto } | null> {
  const team = await Team.findOne({ apiId: teamApiId }).lean();
  if (!team?.area) return null;
  const area = team.area.toLowerCase();
  const round = await currentRoundFor(area);

  if (state === "auto") {
    const override = await GroupVisit.findOne({ teamApiId, source: VisitSource.Manual }).sort({ round: -1 });
    if (override) await override.deleteOne();
    const remaining = await GroupVisit.findOne({ teamApiId, round }).lean();
    return { area, visit: remaining ? toDto(remaining) : { area, teamApiId, round, state: "not_visited", source: "auto", visitedAt: null } };
  }

  const doc = await GroupVisit.findOneAndUpdate(
    { teamApiId, round },
    { $set: { area, state, source: VisitSource.Manual, visitedAt: state === "visited" ? now : null, evidence: "manual" } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  return { area, visit: toDto(doc as VisitDoc) };
}

/** Visits of every area's current round (round 1 for areas without a stored prediction). */
export async function listCurrentVisits(): Promise<VisitDto[]> {
  const [predictions, docs] = await Promise.all([Prediction.find({}, { area: 1, round: 1 }).lean(), GroupVisit.find().sort({ teamApiId: 1 }).lean()]);
  const roundByArea = new Map(predictions.map((prediction) => [prediction.area, prediction.round ?? 1]));
  return docs.filter((doc) => doc.round === (roundByArea.get(doc.area) ?? 1)).map(toDto);
}
```

`src/services/prediction/transit-stop.service.ts`

```ts
import { Team } from "../../models/team.model";
import { TransitStop } from "../../models/transit-stop.model";
import { distanceM, paddedBbox } from "./geo";
import type { StopSource } from "./routing";
import type { LngLat } from "./types";

export const STOPS_PADDING_M = 10_000;

/**
 * Fetch public-transport stops within the bounding box of all groups + 10 km and replace the
 * stored ones. An empty result keeps the existing stops.
 * @returns The number of stored stops (0 when nothing changed)
 */
export async function refreshTransitStops(source: StopSource): Promise<number> {
  const teams = await Team.find({}, { location: 1 }).lean();
  const points = teams.map((team) => [team.location.coordinates[0], team.location.coordinates[1]] as LngLat);
  if (points.length === 0) return 0;
  const stops = await source.fetchStops(paddedBbox(points, STOPS_PADDING_M));
  if (stops.length === 0) return 0;
  await TransitStop.deleteMany({});
  await TransitStop.insertMany(
    stops.map((stop) => ({ osmId: stop.osmId, name: stop.name, kind: stop.kind, location: { type: "Point", coordinates: [stop.lng, stop.lat] } })),
  );
  return stops.length;
}

/** Metres to the nearest stored stop, Infinity when there are none. */
export async function nearestStopDistanceM(position: LngLat): Promise<number> {
  const stop = await TransitStop.findOne({ location: { $nearSphere: { $geometry: { type: "Point", coordinates: position } } } }).lean();
  if (!stop?.location) return Infinity;
  return distanceM(position, [stop.location.coordinates[0], stop.location.coordinates[1]]);
}
```

- [ ] **Step 6: Run tests and static checks**

Run: `bun_ test src/services/prediction/` → all PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/models/group-visit.model.ts src/models/prediction-model.model.ts src/models/prediction.model.ts src/models/routing-cache.model.ts src/models/transit-stop.model.ts src/services/prediction/routing-cache.ts src/services/prediction/routing-cache.test.ts src/services/prediction/visit.service.ts src/services/prediction/visit.service.test.ts src/services/prediction/transit-stop.service.ts src/services/prediction/transit-stop.service.test.ts src/test/prediction-fixtures.ts
git commit -m "feat(prediction): add prediction models, routing cache, visit and stop services

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Prediction service (server)

**Files:**
- Create: `src/services/prediction/prediction.service.ts`
- Test: `src/services/prediction/prediction.service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5: `computeHeading`, `scoreCandidates` (scoring); `planTour` (tour); `assignRounds`, `candidateIds`, `detectPointVisits`, `detectRouteVisits`, `ManualVisit`, `RoundState` (visits); `speedSample`, `updateSpeedFactor`, `dwellSample`, `updateDwell`, `updateWeights`, `evaluateSnapshot`, `Accuracy`, `SnapshotCandidate` (learning); `ISOCHRONE_RANGES_MIN`, `elapsedMinutes`, `zoneRanges`, `pickRing` (zones); `isTransitMode`, `chooseTravel`, `alightingStops`, `selectIslands`, `TravelChoice` (transit); `straightLineSeconds`, `straightLineRouter`; `RoutingUnavailableError`, `TransitUnavailableError`, `WalkingRouter`, `TransitPlanner`, `TransitItinerary`, `RouteResult`; `readCache`, `writeCache`; `loadManualVisits`, `manualVisitsVersion`, `replaceAutoVisits`; `nearestStopDistanceM`; models `Area`, `Marker`, `Team`, `Prediction`, `PredictionModel`; fixtures `makeTeam`, `addObservation`, `setAreaStatus`.
- Produces:
  - `interface PredictionDeps { walking: WalkingRouter; fallback: WalkingRouter; transit: TransitPlanner; now?: () => Date }`
  - `interface CandidateDto { teamApiId: number; name: string; lng: number; lat: number; probability: number; travelMinutes: number; eta: Date; via: "walk" | "transit"; transitLabel?: string; overdue: boolean }`
  - `interface PredictionDto { area: string; status: string; mode: "walking" | "transit"; estimate: boolean; transitUnavailable: boolean; lastObservation: { time: Date; lng: number; lat: number; kind: ObservationKind } | null; zone: { core: PolygonGeometry | null; outer: PolygonGeometry | null; islands: PolygonGeometry[] }; candidates: CandidateDto[]; accuracy: Accuracy; updatedAt: Date; paused: boolean; reason?: string; round: number }`
  - `createPredictionService(deps: PredictionDeps): { recomputeArea(area: string): Promise<PredictionDto>; recomputeDue(): Promise<{ recomputed: string[]; failed: { area: string; error: unknown }[] }> }`
  - `listPredictions(): Promise<unknown[]>` (stored predictions without `snapshot`/`signature`, sorted by area)
  - `listAreaNames(): Promise<string[]>` (lowercase names from `Area` and `Team.area`)
  - `coordKey(position: LngLat): string`

Behaviour summary (the implementer must keep all of it): per-area lock; visits recomputed from scratch; learning on each new hint (speed EMA, pending snapshot from the previous stored prediction, evaluation + weight step at the first visit after the snapshot's observation, dwell EMA); `red` → paused (`Inactief, voorspelling gepauzeerd`), no observations → `Nog geen waarnemingen`, no groups → `Geen groepen gekoppeld`; walking via cached ORS matrices divided by `speedFactor`; transit mode → per candidate a cached Transitous plan and `min(walk, transit)`; tour first stop from the group-to-group matrix; softmax; top 3 with ETA/overdue; zones from one cached isochrone call per position; islands in transit mode; `RoutingUnavailableError` → straight-line fallback + `estimate: true` (fallback results are not cached); `TransitUnavailableError` → walking only + `transitUnavailable: true`; any other error fails only that area and leaves its previous stored prediction in place.

- [ ] **Step 1: Write the failing test** — `src/services/prediction/prediction.service.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun_ test src/services/prediction/prediction.service.test.ts`
Expected: FAIL — `Cannot find module './prediction.service'`.

- [ ] **Step 3: Implement** — `src/services/prediction/prediction.service.ts`

```ts
import { Area } from "../../models/area.model";
import { Marker } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { PredictionModel } from "../../models/prediction-model.model";
import { Team } from "../../models/team.model";
import { RECOMPUTE_INTERVAL_MS, TOP_CANDIDATES, TRANSIT_CACHE_MS, VISIT_RADIUS_M } from "./constants";
import { distanceM } from "./geo";
import {
  dwellSample,
  evaluateSnapshot,
  speedSample,
  updateDwell,
  updateSpeedFactor,
  updateWeights,
  type Accuracy,
  type SnapshotCandidate,
} from "./learning";
import { RoutingUnavailableError, TransitUnavailableError, type RouteResult, type TransitItinerary, type TransitPlanner, type WalkingRouter } from "./routing";
import { readCache, writeCache } from "./routing-cache";
import { computeHeading, scoreCandidates } from "./scoring";
import { straightLineSeconds } from "./straight-line.router";
import { planTour } from "./tour";
import { alightingStops, chooseTravel, isTransitMode, selectIslands, type TravelChoice } from "./transit";
import { nearestStopDistanceM } from "./transit-stop.service";
import { DEFAULT_PARAMS, type GroupRef, type LngLat, type Observation, type ObservationKind, type PolygonGeometry, type Weights } from "./types";
import { loadManualVisits, manualVisitsVersion, replaceAutoVisits } from "./visit.service";
import { assignRounds, candidateIds, detectPointVisits, detectRouteVisits, type ManualVisit, type RoundState } from "./visits";
import { elapsedMinutes, ISOCHRONE_RANGES_MIN, pickRing, zoneRanges } from "./zones";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface PredictionDeps {
  walking: WalkingRouter;
  /** Used when `walking` throws RoutingUnavailableError */
  fallback: WalkingRouter;
  transit: TransitPlanner;
  now?: () => Date;
}

export interface CandidateDto {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
  probability: number;
  travelMinutes: number;
  eta: Date;
  via: "walk" | "transit";
  transitLabel?: string;
  overdue: boolean;
}

export interface PredictionDto {
  area: string;
  status: string;
  mode: "walking" | "transit";
  estimate: boolean;
  transitUnavailable: boolean;
  lastObservation: { time: Date; lng: number; lat: number; kind: ObservationKind } | null;
  zone: { core: PolygonGeometry | null; outer: PolygonGeometry | null; islands: PolygonGeometry[] };
  candidates: CandidateDto[];
  accuracy: Accuracy;
  updatedAt: Date;
  paused: boolean;
  reason?: string;
  round: number;
}

interface PendingSnapshot {
  basedOn: Date;
  candidates: SnapshotCandidate[];
}

interface LearnedModel {
  speedFactor: number;
  dwellMinutes: number;
  weights: Weights;
  accuracy: Accuracy;
  lastHintTime: Date | null;
  lastDwellVisitAt: Date | null;
  pendingSnapshot: PendingSnapshot | null;
}

interface ObservationRecord extends Observation {
  id: string;
}

interface AreaContext {
  area: string;
  status: string;
  groups: GroupRef[];
  observations: ObservationRecord[];
}

interface RunFlags {
  estimate: boolean;
  transitUnavailable: boolean;
}

interface VisitedAt {
  teamApiId: number;
  visitedAt: Date;
}

interface PredictedPart {
  mode: "walking" | "transit";
  zone: PredictionDto["zone"];
  candidates: CandidateDto[];
  snapshot: SnapshotCandidate[];
}

/** Stable cache key for a coordinate (~1 m precision). */
export function coordKey([lng, lat]: LngLat): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/** Lowercase names of all known areas (from the Jotihunt areas and the groups' areas). */
export async function listAreaNames(): Promise<string[]> {
  const [areaNames, teamAreas] = await Promise.all([Area.distinct("name"), Team.distinct("area")]);
  const names = [...areaNames, ...teamAreas].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/** Stored predictions for the API (without the learning snapshot and the signature). */
export async function listPredictions() {
  return Prediction.find({}, { _id: 0, __v: 0, snapshot: 0, signature: 0 }).sort({ area: 1 }).lean();
}

async function loadContext(area: string): Promise<AreaContext> {
  const nameRegex = new RegExp(`^${escapeRegExp(area)}$`, "i");
  const [areaDoc, teams, markers] = await Promise.all([
    Area.findOne({ name: nameRegex }).lean(),
    Team.find({ area: nameRegex }).lean(),
    Marker.find({ area: nameRegex }).sort({ time: 1 }).lean(),
  ]);
  return {
    area,
    status: areaDoc?.status ?? "unknown",
    groups: teams
      .map((team) => ({ teamApiId: team.apiId, name: team.name, lng: team.location.coordinates[0], lat: team.location.coordinates[1] }))
      .sort((a, b) => a.teamApiId - b.teamApiId),
    observations: markers.map((marker) => ({
      id: String(marker._id),
      time: marker.time,
      lng: marker.location.coordinates[0],
      lat: marker.location.coordinates[1],
      kind: marker.type as ObservationKind,
    })),
  };
}

async function signatureFor(ctx: AreaContext): Promise<string> {
  const last = ctx.observations.at(-1);
  return [
    ctx.status,
    ctx.groups.map((group) => group.teamApiId).join(","),
    ctx.observations.length,
    last ? `${last.id}@${last.time.toISOString()}` : "-",
    await manualVisitsVersion(ctx.area),
  ].join("|");
}

async function loadModel(area: string): Promise<LearnedModel> {
  const doc = (await PredictionModel.findOne({ area }).lean()) ?? (await PredictionModel.create({ area })).toObject();
  const defaults = DEFAULT_PARAMS.weights;
  return {
    speedFactor: doc.speedFactor ?? DEFAULT_PARAMS.speedFactor,
    dwellMinutes: doc.dwellMinutes ?? DEFAULT_PARAMS.dwellMinutes,
    weights: {
      wTime: doc.weights?.wTime ?? defaults.wTime,
      wHeading: doc.weights?.wHeading ?? defaults.wHeading,
      wTour: doc.weights?.wTour ?? defaults.wTour,
      wCluster: doc.weights?.wCluster ?? defaults.wCluster,
    },
    accuracy: {
      top1Hits: doc.accuracy?.top1Hits ?? 0,
      top3Hits: doc.accuracy?.top3Hits ?? 0,
      evaluations: doc.accuracy?.evaluations ?? 0,
    },
    lastHintTime: doc.lastHintTime ?? null,
    lastDwellVisitAt: doc.lastDwellVisitAt ?? null,
    pendingSnapshot: (doc.pendingSnapshot as PendingSnapshot | null | undefined) ?? null,
  };
}

async function saveModel(area: string, model: LearnedModel): Promise<void> {
  await PredictionModel.updateOne({ area }, { $set: model });
}

function visitedList(state: RoundState, manual: ManualVisit[]): VisitedAt[] {
  return [
    ...state.autoVisits.map((visit) => ({ teamApiId: visit.teamApiId, visitedAt: visit.visitedAt })),
    ...manual
      .filter((visit) => visit.state === "visited" && visit.visitedAt)
      .map((visit) => ({ teamApiId: visit.teamApiId, visitedAt: visit.visitedAt as Date })),
  ].sort((a, b) => a.visitedAt.getTime() - b.visitedAt.getTime());
}

/**
 * Prediction service. Routing clients are injected so tests run without network.
 */
export function createPredictionService(deps: PredictionDeps) {
  const now = deps.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();

  /** Run tasks for the same area one at a time (cron and PUT /visits can overlap). */
  function withLock<T>(area: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(area) ?? Promise.resolve();
    const run = previous.then(task);
    locks.set(
      area,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Cached walking-router call; on RoutingUnavailableError use the fallback router (not cached). */
  async function routed<T>(flags: RunFlags, key: string, ttlMs: number, request: (router: WalkingRouter) => Promise<T>): Promise<T> {
    const hit = await readCache<T>(key);
    if (hit !== undefined) return hit;
    try {
      const value = await request(deps.walking);
      await writeCache(key, value, ttlMs);
      return value;
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      flags.estimate = true;
      return request(deps.fallback);
    }
  }

  function routeBetween(flags: RunFlags, a: Observation, b: Observation): Promise<RouteResult> {
    const from: LngLat = [a.lng, a.lat];
    const to: LngLat = [b.lng, b.lat];
    if (distanceM(from, to) < 10) return Promise.resolve({ line: [from, to], distanceM: 0, durationS: 0 });
    return routed(flags, `route:${coordKey(from)}>${coordKey(to)}`, WEEK_MS, (router) => router.route(from, to));
  }

  function isochronesAt(flags: RunFlags, center: LngLat) {
    return routed(flags, `iso:${coordKey(center)}`, DAY_MS, (router) => router.isochrones(center, ISOCHRONE_RANGES_MIN));
  }

  async function planTransit(flags: RunFlags, area: string, last: Observation, group: GroupRef, from: LngLat, departAt: Date): Promise<TransitItinerary | null> {
    const key = `transit:${area}:${last.time.toISOString()}:${group.teamApiId}`;
    const hit = await readCache<{ itinerary: TransitItinerary | null }>(key);
    if (hit) return hit.itinerary;
    try {
      const itinerary = await deps.transit.plan(from, [group.lng, group.lat], departAt);
      await writeCache(key, { itinerary }, TRANSIT_CACHE_MS);
      return itinerary;
    } catch (error) {
      if (!(error instanceof TransitUnavailableError)) throw error;
      flags.transitUnavailable = true;
      return null;
    }
  }

  /** Recompute all visits of the area from its observations and store the auto visits. */
  async function syncVisits(flags: RunFlags, ctx: AreaContext): Promise<{ state: RoundState; manual: ManualVisit[] }> {
    const manual = await loadManualVisits(ctx.area);
    const events = detectPointVisits(ctx.observations, ctx.groups);
    if (ctx.groups.length > 0) {
      for (let i = 1; i < ctx.observations.length; i++) {
        const from = ctx.observations[i - 1];
        const to = ctx.observations[i];
        const route = await routeBetween(flags, from, to);
        events.push(...detectRouteVisits(from, to, route.line, ctx.groups));
      }
    }
    const state = assignRounds(
      ctx.groups.map((group) => group.teamApiId),
      events,
      manual,
    );
    await replaceAutoVisits(ctx.area, state.autoVisits);
    return { state, manual };
  }

  /** Live learning: speed, pending snapshot + evaluation, dwell. Mutates `model`. */
  async function learn(flags: RunFlags, ctx: AreaContext, visits: VisitedAt[], previous: { snapshot?: unknown; lastObservation?: unknown } | null, model: LearnedModel) {
    const hints = ctx.observations.filter((observation) => observation.kind === "hint");
    const newest = hints.at(-1);
    if (newest && (!model.lastHintTime || newest.time.getTime() > model.lastHintTime.getTime())) {
      const before = hints.at(-2);
      if (before) {
        const route = await routeBetween(flags, before, newest);
        const sample = speedSample(route.distanceM, minutesBetween(before.time, newest.time), model.dwellMinutes);
        if (sample !== null) model.speedFactor = updateSpeedFactor(model.speedFactor, sample);
      }
      const snapshot = previous?.snapshot as SnapshotCandidate[] | undefined;
      const basedOn = (previous?.lastObservation as { time?: Date } | null | undefined)?.time;
      if (!model.pendingSnapshot && snapshot && snapshot.length > 0 && basedOn) {
        model.pendingSnapshot = { basedOn: new Date(basedOn), candidates: snapshot };
      }
      model.lastHintTime = newest.time;
    }

    const pending = model.pendingSnapshot;
    if (pending) {
      const actual = visits.find((visit) => visit.visitedAt.getTime() > new Date(pending.basedOn).getTime());
      if (actual) {
        model.accuracy = evaluateSnapshot(model.accuracy, pending.candidates, actual.teamApiId);
        model.weights = updateWeights(model.weights, pending.candidates, actual.teamApiId);
        model.pendingSnapshot = null;
      }
    }

    const dwellFrom = model.lastDwellVisitAt?.getTime() ?? 0;
    for (const visit of visits.filter((candidate) => candidate.visitedAt.getTime() > dwellFrom)) {
      const group = ctx.groups.find((candidate) => candidate.teamApiId === visit.teamApiId);
      if (!group) continue;
      const groupLocation: LngLat = [group.lng, group.lat];
      const leave = ctx.observations.find(
        (observation) => observation.time.getTime() > visit.visitedAt.getTime() && distanceM([observation.lng, observation.lat], groupLocation) > VISIT_RADIUS_M,
      );
      if (!leave) break;
      const travelMinutes = straightLineSeconds(groupLocation, [leave.lng, leave.lat]) / 60 / model.speedFactor;
      const sample = dwellSample(visit.visitedAt, leave.time, travelMinutes);
      if (sample !== null) model.dwellMinutes = updateDwell(model.dwellMinutes, sample);
      model.lastDwellVisitAt = visit.visitedAt;
    }
  }

  async function predict(flags: RunFlags, ctx: AreaContext, last: ObservationRecord, state: RoundState, model: LearnedModel, at: Date): Promise<PredictedPart> {
    const position: LngLat = [last.lng, last.lat];
    const coords = ctx.groups.map((group): LngLat => [group.lng, group.lat]);
    const idsKey = ctx.groups.map((group) => group.teamApiId).join(",");
    const fromPosition = await routed(flags, `pmatrix:${coordKey(position)}:${idsKey}`, DAY_MS, (router) => router.matrix([position], coords));
    const between = await routed(flags, `gmatrix:${ctx.area}:${idsKey}`, WEEK_MS, (router) => router.matrix(coords, coords));

    const open = new Set(
      candidateIds(
        ctx.groups.map((group) => group.teamApiId),
        state,
        at,
      ),
    );
    const transitMode = isTransitMode({ area: ctx.area, status: ctx.status, nearestStopDistanceM: await nearestStopDistanceM(position) });
    const departAt = new Date(last.time.getTime() + model.dwellMinutes * 60_000);
    const itineraries: TransitItinerary[] = [];
    const entries: { group: GroupRef; index: number; walkSeconds: number; choice: TravelChoice }[] = [];

    for (const [index, group] of ctx.groups.entries()) {
      if (!open.has(group.teamApiId)) continue;
      const walkSeconds = fromPosition.durationsS[0]?.[index] ?? straightLineSeconds(position, coords[index]);
      let itinerary: TransitItinerary | null = null;
      if (transitMode && !flags.transitUnavailable) {
        itinerary = await planTransit(flags, ctx.area, last, group, position, departAt);
        if (itinerary) itineraries.push(itinerary);
      }
      entries.push({ group, index, walkSeconds, choice: chooseTravel(walkSeconds / 60 / model.speedFactor, itinerary, departAt) });
    }

    const matrix = entries.map((a) =>
      entries.map((b) => (a === b ? 0 : (between.durationsS[a.index]?.[b.index] ?? straightLineSeconds(coords[a.index], coords[b.index])))),
    );
    const tour = planTour(
      entries.map((entry) => entry.walkSeconds),
      matrix,
    );
    const scored = scoreCandidates({
      position,
      heading: computeHeading(ctx.observations),
      tourFirstIndex: tour.length > 0 ? tour[0] : null,
      weights: model.weights,
      candidates: entries.map((entry) => ({ teamApiId: entry.group.teamApiId, location: coords[entry.index], travelMinutes: entry.choice.travelMinutes })),
    });
    const ranked = scored.map((score, index) => ({ ...score, entry: entries[index] })).sort((a, b) => b.probability - a.probability);

    const candidates = ranked.slice(0, TOP_CANDIDATES).map(({ probability, entry }) => {
      const eta = new Date(last.time.getTime() + (model.dwellMinutes + entry.choice.travelMinutes) * 60_000);
      const candidate: CandidateDto = {
        teamApiId: entry.group.teamApiId,
        name: entry.group.name,
        lng: entry.group.lng,
        lat: entry.group.lat,
        probability,
        travelMinutes: Math.round(entry.choice.travelMinutes),
        eta,
        via: entry.choice.via,
        overdue: eta.getTime() < at.getTime(),
      };
      if (entry.choice.transitLabel) candidate.transitLabel = entry.choice.transitLabel;
      return candidate;
    });
    const snapshot = ranked.map(({ teamApiId, probability, terms }) => ({ teamApiId, probability, terms }));

    const { outerMin, coreMin } = zoneRanges(elapsedMinutes(at, last.time, model.dwellMinutes), model.speedFactor);
    const rings = await isochronesAt(flags, position);
    const zone: PredictionDto["zone"] = { core: pickRing(rings, position, coreMin), outer: pickRing(rings, position, outerMin), islands: [] };
    if (transitMode) {
      for (const { stop, remainingMinutes } of selectIslands(alightingStops(itineraries), at)) {
        const center: LngLat = [stop.lng, stop.lat];
        zone.islands.push(pickRing(await isochronesAt(flags, center), center, zoneRanges(remainingMinutes, model.speedFactor).outerMin));
      }
    }

    return { mode: transitMode ? "transit" : "walking", zone, candidates, snapshot };
  }

  async function compute(ctx: AreaContext, signature: string): Promise<PredictionDto> {
    const at = now();
    const flags: RunFlags = { estimate: false, transitUnavailable: false };
    const previous = await Prediction.findOne({ area: ctx.area }).lean();
    const model = await loadModel(ctx.area);
    const { state, manual } = await syncVisits(flags, ctx);
    if (ctx.groups.length > 0) await learn(flags, ctx, visitedList(state, manual), previous, model);
    await saveModel(ctx.area, model);

    const last = ctx.observations.at(-1);
    const dto: PredictionDto = {
      area: ctx.area,
      status: ctx.status,
      mode: "walking",
      estimate: false,
      transitUnavailable: false,
      lastObservation: last ? { time: last.time, lng: last.lng, lat: last.lat, kind: last.kind } : null,
      zone: { core: null, outer: null, islands: [] },
      candidates: [],
      accuracy: model.accuracy,
      updatedAt: at,
      paused: false,
      round: state.currentRound,
    };
    let snapshot: SnapshotCandidate[] = [];

    if (ctx.groups.length === 0) {
      dto.reason = "Geen groepen gekoppeld";
    } else if (ctx.status === "red") {
      dto.paused = true;
      dto.reason = "Inactief, voorspelling gepauzeerd";
    } else if (!last) {
      dto.reason = "Nog geen waarnemingen";
    } else {
      const part = await predict(flags, ctx, last, state, model, at);
      dto.mode = part.mode;
      dto.zone = part.zone;
      dto.candidates = part.candidates;
      snapshot = part.snapshot;
    }

    dto.estimate = flags.estimate;
    dto.transitUnavailable = flags.transitUnavailable;
    await Prediction.replaceOne({ area: ctx.area }, { ...dto, snapshot, signature }, { upsert: true });
    return dto;
  }

  /** Recompute one area now (e.g. after a manual visit change). */
  function recomputeArea(area: string): Promise<PredictionDto> {
    const name = area.toLowerCase();
    return withLock(name, async () => {
      const ctx = await loadContext(name);
      return compute(ctx, await signatureFor(ctx));
    });
  }

  /**
   * Recompute every area whose inputs changed (observations, status, groups, manual visits)
   * or whose prediction is at least 5 minutes old. One failing area never stops the others.
   */
  async function recomputeDue(): Promise<{ recomputed: string[]; failed: { area: string; error: unknown }[] }> {
    const recomputed: string[] = [];
    const failed: { area: string; error: unknown }[] = [];
    for (const area of await listAreaNames()) {
      try {
        const done = await withLock(area, async () => {
          const ctx = await loadContext(area);
          const signature = await signatureFor(ctx);
          const previous = await Prediction.findOne({ area }, { signature: 1, updatedAt: 1 }).lean();
          const fresh = previous && previous.signature === signature && now().getTime() - new Date(previous.updatedAt).getTime() < RECOMPUTE_INTERVAL_MS;
          if (fresh) return false;
          await compute(ctx, signature);
          return true;
        });
        if (done) recomputed.push(area);
      } catch (error) {
        failed.push({ area, error });
      }
    }
    return { recomputed, failed };
  }

  return { recomputeArea, recomputeDue };
}
```

- [ ] **Step 4: Run tests and static checks**

Run: `bun_ test src/services/prediction/prediction.service.test.ts` → all PASS. Then `bun_ test` (whole suite), `bun_ run typecheck`, `bun_ run lint` → no errors. If `tsc` complains about the `lean()` document shapes in `loadModel` (e.g. optional nested paths), keep the `??` defaults and add a local `as` cast to the documented field types rather than loosening `LearnedModel`.

- [ ] **Step 5: Commit**

```bash
git add src/services/prediction/prediction.service.ts src/services/prediction/prediction.service.test.ts
git commit -m "feat(prediction): orchestrate per-area fox predictions with learning and fallbacks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: Replay acceptance test (server)

**Files:**
- Test: `src/services/prediction/replay.test.ts`

**Interfaces:**
- Consumes: `createPredictionService`, `PredictionDeps` (Task 6); `straightLineRouter` (Task 3); `moveM`, `distanceM` (Task 1); `VISIT_RADIUS_M`, `WALK_M_PER_MIN`, `DETOUR_FACTOR` (Task 1); `makeTeam`, `addObservation`, `setAreaStatus` (Task 5); `PredictionModel` (Task 5).
- Produces: nothing (acceptance test for the spec's replay requirement).

Scenario: 8 alpha groups roughly on a line, 2 km apart, with small north/south offsets (≤ 120 m). The fox walks them in order at the speed the model assumes for `speedFactor = 1` (straight line × 1.3 at 5 km/h), stays 15 minutes at each group and reports a hint every hour. After each hint the area is recomputed with a straight-line routing mock. From the 3rd hint on, the true next group is the first group the fox has not yet reached; a group the fox is already within 300 m of counts as reached (the service rightly marks it visited). Requirement: the top-3 contains the true next group in ≥ 70 % of those hours.

- [ ] **Step 1: Write the test** — `src/services/prediction/replay.test.ts`

```ts
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
```

- [ ] **Step 2: Run the test**

Run: `bun_ test src/services/prediction/replay.test.ts`
Expected: PASS (1 test). With the scenario above there are 6 hints (0–300 min) and 4 evaluated hours; all 4 should hit. If it fails, do **not** tune the scenario: print `prediction.candidates` and the true group per hour and fix the service (Task 6) — the scenario is the spec's acceptance criterion.

- [ ] **Step 3: Full suite and static checks** — `bun_ test`, `bun_ run typecheck`, `bun_ run lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/services/prediction/replay.test.ts
git commit -m "test(prediction): replay a scripted fox route against the predictor

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: API routes, cron, wiring and configuration (server)

**Files:**
- Create: `src/services/prediction/instance.ts`, `src/controllers/predictions.controller.ts`, `src/routes/predictions.route.ts`, `src/routes/visits.route.ts`, `src/crons/prediction.cron.ts`
- Modify: `src/routes/admin.route.ts`, `src/index.ts`, `.env.example`, `README.md`
- Modify (outside the repo, not committed): `/home/silke/Documents/Jotihunt 2026/.env.example`, `/home/silke/Documents/Jotihunt 2026/.env`

**Interfaces:**
- Consumes: `createPredictionService`, `listPredictions` (Task 6); `createOrsRouter`, `createTransitousPlanner`, `createOverpassSource` (Task 4); `straightLineRouter` (Task 3); `listCurrentVisits`, `setManualVisit`, `refreshTransitStops` (Task 5); `TransitStop` model; `verifyToken`, `isAdmin`, `validate`.
- Produces (HTTP):
  - `GET /predictions` (auth) → stored predictions array (see `PredictionDto`; dates as ISO strings).
  - `GET /visits` (auth) → `VisitDto[]` of the current rounds.
  - `PUT /visits/:teamApiId` (auth) body `{ state: "visited" | "not_visited" | "auto" }` → `VisitDto`; 400 on invalid input, 404 for unknown / area-less groups; triggers an async recompute of that area.
  - `POST /admin/transit-stops/refresh` (admin) → `{ count: number }`, 502 `{ message }` when Overpass fails.
  - Module exports: `predictionService`, `stopSource` (instance.ts); `recomputePredictions` (default export of the cron).

- [ ] **Step 1: Singleton** — `src/services/prediction/instance.ts`

```ts
import { createOrsRouter } from "./ors.client";
import { createOverpassSource } from "./overpass.client";
import { createPredictionService } from "./prediction.service";
import { straightLineRouter } from "./straight-line.router";
import { createTransitousPlanner } from "./transitous.client";

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  walking: createOrsRouter(process.env.ORS_API_KEY || undefined),
  fallback: straightLineRouter,
  transit: createTransitousPlanner(),
});

export const stopSource = createOverpassSource();
```

- [ ] **Step 2: Controller** — `src/controllers/predictions.controller.ts`

```ts
import { Request, Response } from "express";
import { logger } from "..";
import { predictionService, stopSource } from "../services/prediction/instance";
import { listPredictions } from "../services/prediction/prediction.service";
import { refreshTransitStops } from "../services/prediction/transit-stop.service";
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
  // Recompute in the background so the response stays fast (routing can take seconds)
  predictionService.recomputeArea(result.area).catch((error) => logger.error(`Recomputing prediction for ${result.area} failed`, error));
  return res.status(200).json(result.visit);
}

export async function refreshStops(_req: Request, res: Response) {
  try {
    return res.status(200).json({ count: await refreshTransitStops(stopSource) });
  } catch (error) {
    logger.error("Refreshing transit stops failed", error);
    return res.status(502).json({ message: "Haltes ophalen is mislukt, probeer het later opnieuw." });
  }
}
```

- [ ] **Step 3: Routes**

`src/routes/predictions.route.ts`

```ts
import express from "express";
import * as predictionsController from "../controllers/predictions.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

router.get("/", verifyToken, predictionsController.getPredictions);

export default router;
```

`src/routes/visits.route.ts`

```ts
import express from "express";
import { body, param } from "express-validator";
import * as predictionsController from "../controllers/predictions.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

router.get("/", verifyToken, predictionsController.getVisits);
router.put(
  "/:teamApiId",
  [
    verifyToken,
    validate([
      param("teamApiId").isInt({ min: 0 }).withMessage("Ongeldig groeps-ID."),
      body("state").isIn(["visited", "not_visited", "auto"]).withMessage("Status moet visited, not_visited of auto zijn."),
    ]),
  ],
  predictionsController.putVisit,
);

export default router;
```

In `src/routes/admin.route.ts` add below the existing imports:

```ts
import * as predictionsController from "../controllers/predictions.controller";
```

and below the `router.put("/users/:id", …)` line:

```ts
router.post("/transit-stops/refresh", [verifyToken, isAdmin], predictionsController.refreshStops);
```

- [ ] **Step 4: Cron** — `src/crons/prediction.cron.ts`

```ts
import { logger } from "..";
import { TransitStop } from "../models/transit-stop.model";
import { predictionService, stopSource } from "../services/prediction/instance";
import { refreshTransitStops } from "../services/prediction/transit-stop.service";

const STOP_RETRY_MS = 60 * 60 * 1000;
let lastStopAttempt = 0;

/** Fetch transit stops once (retry at most hourly while the collection is empty). */
async function ensureTransitStops() {
  if (Date.now() - lastStopAttempt < STOP_RETRY_MS) return;
  if ((await TransitStop.estimatedDocumentCount()) > 0) return;
  lastStopAttempt = Date.now();
  refreshTransitStops(stopSource)
    .then((count) => logger.info(`(CRON) Stored ${count} transit stops`))
    .catch((error) => logger.warn("(CRON) Could not fetch transit stops", error));
}

export default async function recomputePredictions() {
  await ensureTransitStops();
  const { recomputed, failed } = await predictionService.recomputeDue();
  if (recomputed.length > 0) logger.info(`(CRON) Recomputed fox predictions for ${recomputed.join(", ")}`);
  for (const failure of failed) logger.error(`(CRON) Fox prediction for ${failure.area} failed`, failure.error);
}
```

- [ ] **Step 5: Wire up `src/index.ts`**

Add to the imports (after `import hintsRoute from "./routes/hints.route";`):

```ts
import predictionsRoute from "./routes/predictions.route";
import visitsRoute from "./routes/visits.route";
```

and after `import scrapeJotihuntWebsite from "./crons/jotihunt-scraper.cron";`:

```ts
import recomputePredictions from "./crons/prediction.cron";
```

After `app.use("/hints", hintsRoute);` add:

```ts
app.use("/predictions", predictionsRoute);
app.use("/visits", visitsRoute);
```

At the end of the file (after the Traccar warning) add:

```ts
// Fox prediction: recompute changed areas every minute (and every area at least every 5 minutes)
cron.schedule("30 * * * * *", recomputePredictions, { name: "fox-prediction", noOverlap: true });
if (!process.env.ORS_API_KEY) {
  logger.warn("ORS_API_KEY not set, fox prediction uses straight-line estimates");
}
```

- [ ] **Step 6: Configuration**

In `.env.example` (server repo) append:

```env

# Fox prediction (OpenRouteService). Optional: without a key straight-line estimates are used.
ORS_API_KEY=
```

In the root env files (not a git repo) add an empty key after `JOTIHUNT_WEB_PASSWORD`:

```bash
cd "/home/silke/Documents/Jotihunt 2026"
grep -q '^ORS_API_KEY=' .env.example || sed -i '/^JOTIHUNT_WEB_PASSWORD=/a ORS_API_KEY=' .env.example
grep -q '^ORS_API_KEY=' .env || sed -i '/^JOTIHUNT_WEB_PASSWORD=/a ORS_API_KEY=' .env
grep -n ORS_API_KEY .env.example .env
```

Expected: one `ORS_API_KEY=` line in each file.

In `README.md` (server repo): in the `.env` example block, add after the line `HUNT_END_TIME=2025-10-19T12:00+02:00 # …`:

```env
ORS_API_KEY= # Optioneel, voor de vossenvoorspelling (zie configuratie)
```

and in `## ⚙️ Configuratie` → `### Omgevingsvariabelen`, directly before the heading ``#### `JWT_SECRET` ``, add:

```markdown
#### `ORS_API_KEY` (optioneel)
Wordt gebruikt door de vossenvoorspelling voor looptijden, looproutes en bereikbaarheidszones via [OpenRouteService](https://openrouteservice.org/).
1. Maak een gratis account aan op [openrouteservice.org](https://openrouteservice.org/dev/#/signup).
2. Maak in het dashboard een (gratis) token aan.
3. Plak de key in de `.env` file bij `ORS_API_KEY`.

Zonder key werkt de voorspelling ook, maar dan met schattingen (rechte lijn × 1,3 bij 5 km/u en cirkelvormige zones); de client toont dan "(schatting)".
Reizen met het openbaar vervoer komen van [Transitous](https://transitous.org/) en de haltes van OpenStreetMap (Overpass API); daarvoor is geen key nodig. Er worden alleen coördinaten en tijden verstuurd, geen persoonsgegevens.
```

- [ ] **Step 7: Static checks** — `bun_ test`, `bun_ run typecheck`, `bun_ run lint` → clean.

- [ ] **Step 8: Smoke test on the local stack**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose up -d --build server
sleep 75   # let the fox-prediction cron (second 30) run at least once
docker compose logs server --since 2m | grep -i "fox prediction\|ORS_API_KEY"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"solver@local.test","password":"Solver123456"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s localhost:3000/predictions -H "Authorization: Bearer $TOKEN" | head -c 400; echo
curl -s localhost:3000/visits -H "Authorization: Bearer $TOKEN"; echo
curl -s -o /dev/null -w "%{http_code}\n" -X PUT localhost:3000/visits/1 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"state":"maybe"}'
curl -s -o /dev/null -w "%{http_code}\n" -X PUT localhost:3000/visits/123456789 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"state":"visited"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/admin/transit-stops/refresh -H "Authorization: Bearer $TOKEN"
```

Expected:
- log line `ORS_API_KEY not set, fox prediction uses straight-line estimates` (the local `.env` has an empty key) and `(CRON) Recomputed fox predictions for alpha, bravo, …`;
- `/predictions` → a JSON array with one entry per area (`"reason":"Geen groepen gekoppeld"` while the local DB has no teams), no `snapshot`/`signature` fields;
- `/visits` → `[]`;
- invalid state → `400`; unknown group → `404`; admin refresh as solver (not admin) → `401`.

- [ ] **Step 9: Commit**

```bash
git add src/services/prediction/instance.ts src/controllers/predictions.controller.ts src/routes/predictions.route.ts src/routes/visits.route.ts src/routes/admin.route.ts src/crons/prediction.cron.ts src/index.ts .env.example README.md
git commit -m "feat(prediction): expose predictions and visits API and schedule recomputes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 9: Client data layer — types, hooks and prediction helpers (client)

Run in `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client` with the client `bun_`.

**Files:**
- Create: `src/types/Prediction.ts`, `src/hooks/predictions.hook.ts`, `src/lib/prediction.ts`
- Test: `src/lib/prediction.test.ts`

**Interfaces:**
- Consumes: server API from Task 8; `useAuthSWR`, `fetcherWithMethod` (`src/lib/swr.ts`).
- Produces:
  - types: `GeoPolygon`, `PredictionCandidate { teamApiId; name; lng; lat; probability; travelMinutes; eta: string; via: 'walk' | 'transit'; transitLabel?: string; overdue: boolean }`, `PredictionAccuracy { top1Hits; top3Hits; evaluations }`, `Prediction { area; status; mode: 'walking' | 'transit'; estimate; transitUnavailable; lastObservation: { time: string; lng; lat; kind: 'hint' | 'hunt' | 'spot' } | null; zone: { core: GeoPolygon | null; outer: GeoPolygon | null; islands: GeoPolygon[] }; candidates: PredictionCandidate[]; accuracy: PredictionAccuracy; updatedAt: string; paused: boolean; reason?: string; round: number }`, `VisitState = 'visited' | 'not_visited'`, `VisitChoice = VisitState | 'auto'`, `GroupVisit { area; teamApiId; round; state: VisitState; source: 'auto' | 'manual'; visitedAt: string | null }`
  - hooks: `usePredictions(): { predictions?: Prediction[]; isLoading: boolean; isError: unknown }`, `useVisits(): { visits?: GroupVisit[]; isLoading: boolean; isError: unknown; setVisit(teamApiId: number, state: VisitChoice): Promise<GroupVisit> }` (both poll every 15 s)
  - lib: `formatClock(iso: string): string`, `candidateLabel(candidate): string`, `accuracyLabel(accuracy): string`, `predictionStatusText(prediction): string | null`, `predictionSummary(predictions?: Prediction[]): string | undefined`, `visitSelection(visit?: GroupVisit): VisitChoice`, `visitStatusText(visit?: GroupVisit): string`, `interface ZoneProperties { area; color; kind: 'core' | 'outer' | 'island'; estimate: boolean }`, `interface LineProperties { area; color; probability }`, `interface PredictionLabel { key; lng; lat; text; color }`, `buildPredictionGeoJson(predictions: Prediction[], colorFor: (area: string) => string): { zones: FeatureCollection<Polygon, ZoneProperties>; lines: FeatureCollection<LineString, LineProperties>; labels: PredictionLabel[] }`

- [ ] **Step 1: Types** — `src/types/Prediction.ts`

```ts
import type { Polygon } from 'geojson';

export type GeoPolygon = Polygon;

export interface PredictionCandidate {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
  /** 0–1 */
  probability: number;
  travelMinutes: number;
  /** ISO time */
  eta: string;
  via: 'walk' | 'transit';
  transitLabel?: string;
  /** The ETA has passed: "had er al kunnen zijn" */
  overdue: boolean;
}

export interface PredictionAccuracy {
  top1Hits: number;
  top3Hits: number;
  evaluations: number;
}

export interface Prediction {
  area: string;
  status: string;
  mode: 'walking' | 'transit';
  /** Straight-line fallback was used (no ORS key or ORS error) */
  estimate: boolean;
  transitUnavailable: boolean;
  lastObservation: { time: string; lng: number; lat: number; kind: 'hint' | 'hunt' | 'spot' } | null;
  zone: { core: GeoPolygon | null; outer: GeoPolygon | null; islands: GeoPolygon[] };
  candidates: PredictionCandidate[];
  accuracy: PredictionAccuracy;
  updatedAt: string;
  paused: boolean;
  reason?: string;
  round: number;
}

export type VisitState = 'visited' | 'not_visited';
export type VisitChoice = VisitState | 'auto';

export interface GroupVisit {
  area: string;
  teamApiId: number;
  round: number;
  state: VisitState;
  source: 'auto' | 'manual';
  visitedAt: string | null;
}
```

- [ ] **Step 2: Write the failing test** — `src/lib/prediction.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import type { GroupVisit, Prediction, PredictionCandidate } from '@/types/Prediction';
import {
  accuracyLabel,
  buildPredictionGeoJson,
  candidateLabel,
  predictionStatusText,
  predictionSummary,
  visitSelection,
  visitStatusText,
} from './prediction';

// Local times, so the expected labels don't depend on the machine's time zone
const eta = new Date(2026, 9, 17, 14, 20).toISOString();
const square = { type: 'Polygon' as const, coordinates: [[[5, 52], [5.1, 52], [5.1, 52.1], [5, 52]]] };

function candidate(overrides: Partial<PredictionCandidate> = {}): PredictionCandidate {
  return { teamApiId: 1, name: 'Scouting Test', lng: 5.5, lat: 52.1, probability: 0.62, travelMinutes: 14, eta, via: 'walk', overdue: false, ...overrides };
}

function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    area: 'alpha',
    status: 'green',
    mode: 'walking',
    estimate: false,
    transitUnavailable: false,
    lastObservation: { time: eta, lng: 5.4, lat: 52.0, kind: 'hint' },
    zone: { core: square, outer: square, islands: [] },
    candidates: [candidate()],
    accuracy: { top1Hits: 3, top3Hits: 7, evaluations: 9 },
    updatedAt: eta,
    paused: false,
    round: 1,
    ...overrides,
  };
}

function visit(overrides: Partial<GroupVisit> = {}): GroupVisit {
  return { area: 'alpha', teamApiId: 1, round: 1, state: 'visited', source: 'auto', visitedAt: null, ...overrides };
}

describe('candidateLabel', () => {
  test('probability and ETA', () => expect(candidateLabel(candidate())).toBe('62% · ~14:20'));
  test('transit prefix', () => expect(candidateLabel(candidate({ via: 'transit' }))).toBe('🚆 62% · ~14:20'));
  test('overdue', () => expect(candidateLabel(candidate({ overdue: true }))).toBe('62% · had er al kunnen zijn'));
});

describe('accuracyLabel', () => {
  test('top-3 hits of evaluations', () => expect(accuracyLabel({ top1Hits: 3, top3Hits: 7, evaluations: 9 })).toBe('top-3 7/9'));
  test('no evaluations yet', () => expect(accuracyLabel({ top1Hits: 0, top3Hits: 0, evaluations: 0 })).toBe('top-3 –'));
});

describe('predictionStatusText', () => {
  test('paused shows the reason', () => {
    expect(predictionStatusText(prediction({ paused: true, reason: 'Inactief, voorspelling gepauzeerd', candidates: [] }))).toBe('Inactief, voorspelling gepauzeerd');
  });
  test('reason without pause', () => {
    expect(predictionStatusText(prediction({ reason: 'Nog geen waarnemingen', candidates: [] }))).toBe('Nog geen waarnemingen');
  });
  test('no candidates left', () => {
    expect(predictionStatusText(prediction({ candidates: [] }))).toBe('Geen kandidaten meer in deze ronde');
  });
  test('active prediction has no status text', () => expect(predictionStatusText(prediction())).toBeNull());
});

describe('predictionSummary', () => {
  test('counts active predictions', () => {
    expect(predictionSummary(undefined)).toBeUndefined();
    expect(predictionSummary([prediction(), prediction({ area: 'bravo', paused: true, candidates: [] })])).toBe('1 actief');
    expect(predictionSummary([])).toBe('Geen actieve');
  });
});

describe('visit helpers', () => {
  test('no visit doc → automatic, not visited', () => {
    expect(visitSelection(undefined)).toBe('auto');
    expect(visitStatusText(undefined)).toBe('Nog niet bezocht (automatisch)');
  });

  test('manual override', () => {
    const manual = visit({ state: 'not_visited', source: 'manual' });
    expect(visitSelection(manual)).toBe('not_visited');
    expect(visitStatusText(manual)).toBe('Niet bezocht (handmatig) · ronde 1');
  });

  test('automatic visit with time', () => {
    const auto = visit({ round: 2, visitedAt: new Date(2026, 9, 17, 14, 5).toISOString() });
    expect(visitSelection(auto)).toBe('auto');
    expect(visitStatusText(auto)).toBe('Bezocht (automatisch, 14:05) · ronde 2');
  });
});

describe('buildPredictionGeoJson', () => {
  test('zones, lines and labels for active predictions only', () => {
    const data = buildPredictionGeoJson(
      [
        prediction({ estimate: true, zone: { core: square, outer: square, islands: [square] }, candidates: [candidate(), candidate({ teamApiId: 2, lng: 5.6, probability: 0.2 })] }),
        prediction({ area: 'bravo', paused: true, candidates: [] }),
      ],
      () => '#abcdef',
    );
    expect(data.zones.features.map((feature) => feature.properties)).toEqual([
      { area: 'alpha', color: '#abcdef', kind: 'outer', estimate: true },
      { area: 'alpha', color: '#abcdef', kind: 'core', estimate: true },
      { area: 'alpha', color: '#abcdef', kind: 'island', estimate: true },
    ]);
    expect(data.lines.features).toHaveLength(2);
    expect(data.lines.features[0].geometry.coordinates).toEqual([
      [5.4, 52.0],
      [5.5, 52.1],
    ]);
    expect(data.lines.features[1].properties.probability).toBe(0.2);
    expect(data.labels[0].key).toBe('alpha-1');
    expect(data.labels[0].text).toBe('62% · ~14:20');
    expect(data.labels[0].lng).toBeCloseTo(5.45, 6);
    expect(data.labels[0].lat).toBeCloseTo(52.05, 6);
  });

  test('no lines without a last observation', () => {
    const data = buildPredictionGeoJson([prediction({ lastObservation: null })], () => '#000');
    expect(data.lines.features).toEqual([]);
    expect(data.labels).toEqual([]);
  });
});
```

- [ ] **Step 3: Run** `bun_ test src/lib/prediction.test.ts` → FAIL (`Cannot find module './prediction'`).

- [ ] **Step 4: Implement** — `src/lib/prediction.ts`

```ts
import { format } from 'date-fns';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import type { GeoPolygon, GroupVisit, Prediction, PredictionAccuracy, PredictionCandidate, VisitChoice } from '@/types/Prediction';

export interface ZoneProperties {
  area: string;
  color: string;
  kind: 'core' | 'outer' | 'island';
  estimate: boolean;
}

export interface LineProperties {
  area: string;
  color: string;
  probability: number;
}

export interface PredictionLabel {
  key: string;
  lng: number;
  lat: number;
  text: string;
  color: string;
}

/** 24h local clock time, e.g. "14:20". */
export function formatClock(iso: string): string {
  return format(new Date(iso), 'HH:mm');
}

/** "62% · ~14:20", "🚆 62% · ~14:20" or "62% · had er al kunnen zijn". */
export function candidateLabel(candidate: PredictionCandidate): string {
  const prefix = candidate.via === 'transit' ? '🚆 ' : '';
  const when = candidate.overdue ? 'had er al kunnen zijn' : `~${formatClock(candidate.eta)}`;
  return `${prefix}${Math.round(candidate.probability * 100)}% · ${when}`;
}

export function accuracyLabel(accuracy: PredictionAccuracy): string {
  return accuracy.evaluations === 0 ? 'top-3 –' : `top-3 ${accuracy.top3Hits}/${accuracy.evaluations}`;
}

/** Status text to show instead of the top candidate, or null for an active prediction. */
export function predictionStatusText(prediction: Prediction): string | null {
  if (prediction.paused) return prediction.reason ?? 'Voorspelling gepauzeerd';
  if (prediction.reason) return prediction.reason;
  if (prediction.candidates.length === 0) return 'Geen kandidaten meer in deze ronde';
  return null;
}

/** Collapsed sidebar summary: number of active predictions. */
export function predictionSummary(predictions?: Prediction[]): string | undefined {
  if (!predictions) return undefined;
  const active = predictions.filter((prediction) => !prediction.paused && prediction.candidates.length > 0).length;
  return active === 0 ? 'Geen actieve' : `${active} actief`;
}

/** Which of the three visit buttons is active: a manual state, or automatic. */
export function visitSelection(visit?: GroupVisit): VisitChoice {
  return visit?.source === 'manual' ? visit.state : 'auto';
}

export function visitStatusText(visit?: GroupVisit): string {
  if (!visit) return 'Nog niet bezocht (automatisch)';
  const state = visit.state === 'visited' ? 'Bezocht' : 'Niet bezocht';
  const source = visit.source === 'manual' ? 'handmatig' : 'automatisch';
  const time = visit.state === 'visited' && visit.visitedAt ? `, ${formatClock(visit.visitedAt)}` : '';
  return `${state} (${source}${time}) · ronde ${visit.round}`;
}

/**
 * GeoJSON for the prediction map layer: zones (outer, core, islands), lines from the last
 * position to the candidates and label positions (line midpoints). Paused predictions are skipped.
 */
export function buildPredictionGeoJson(
  predictions: Prediction[],
  colorFor: (area: string) => string,
): { zones: FeatureCollection<Polygon, ZoneProperties>; lines: FeatureCollection<LineString, LineProperties>; labels: PredictionLabel[] } {
  const zones: Feature<Polygon, ZoneProperties>[] = [];
  const lines: Feature<LineString, LineProperties>[] = [];
  const labels: PredictionLabel[] = [];

  for (const prediction of predictions) {
    if (prediction.paused) continue;
    const color = colorFor(prediction.area);
    const addZone = (geometry: GeoPolygon | null, kind: ZoneProperties['kind']) => {
      if (geometry) zones.push({ type: 'Feature', geometry, properties: { area: prediction.area, color, kind, estimate: prediction.estimate } });
    };
    addZone(prediction.zone.outer, 'outer');
    addZone(prediction.zone.core, 'core');
    prediction.zone.islands.forEach((island) => addZone(island, 'island'));

    const last = prediction.lastObservation;
    if (!last) continue;
    for (const candidate of prediction.candidates) {
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[last.lng, last.lat], [candidate.lng, candidate.lat]] },
        properties: { area: prediction.area, color, probability: candidate.probability },
      });
      labels.push({
        key: `${prediction.area}-${candidate.teamApiId}`,
        lng: (last.lng + candidate.lng) / 2,
        lat: (last.lat + candidate.lat) / 2,
        text: candidateLabel(candidate),
        color,
      });
    }
  }

  return { zones: { type: 'FeatureCollection', features: zones }, lines: { type: 'FeatureCollection', features: lines }, labels };
}
```

- [ ] **Step 5: Hooks** — `src/hooks/predictions.hook.ts`

```ts
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod, useAuthSWR } from '@/lib/swr';
import type { GroupVisit, Prediction, VisitChoice } from '@/types/Prediction';

const PREDICTION_REFRESH_MS = 15_000;

export const usePredictions = () => {
  const { data, error } = useAuthSWR<Prediction[]>('/predictions', { refreshInterval: PREDICTION_REFRESH_MS });
  return { predictions: data, isLoading: !error && !data, isError: error };
};

export const useVisits = () => {
  const authHeader = useAuthHeader() || '';
  const { data, error, mutate } = useAuthSWR<GroupVisit[]>('/visits', { refreshInterval: PREDICTION_REFRESH_MS });

  /**
   * Set a manual visit state ('visited' / 'not_visited') or go back to automatic ('auto').
   * Puts the server's answer straight into the cache; throws the axios error on failure.
   */
  async function setVisit(teamApiId: number, state: VisitChoice): Promise<GroupVisit> {
    const visit = (await fetcherWithMethod(`/visits/${teamApiId}`, authHeader, 'PUT', { state })) as GroupVisit;
    await mutate((current) => [...(current ?? []).filter((existing) => existing.teamApiId !== teamApiId), visit], { revalidate: false });
    return visit;
  }

  return { visits: data, isLoading: !error && !data, isError: error, setVisit };
};
```

- [ ] **Step 6: Run tests and static checks**

Run: `bun_ test` → all PASS. Then `bun_ run build` and `bun_ run lint` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types/Prediction.ts src/lib/prediction.ts src/lib/prediction.test.ts src/hooks/predictions.hook.ts
git commit -m "feat(prediction): add prediction types, hooks and label helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: Prediction map layer, layer toggle and visit controls (client)

Run in `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client` with the client `bun_`.

**Files:**
- Create: `src/components/layers/Predictions.tsx`, `src/components/map/VisitControls.tsx`
- Modify: `src/stores/layers.store.ts`, `src/components/Settings.tsx`, `src/components/Map.tsx`, `src/components/layers/Teams.tsx`

**Interfaces:**
- Consumes: `usePredictions`, `useVisits` (Task 9); `buildPredictionGeoJson`, `visitSelection`, `visitStatusText` (Task 9); `VisitChoice` type; `useAreas` (`hiddenAreas`), `getColorFromArea`, shadcn `Button`.
- Produces: `useLayersStore` gains `showPredictions: boolean` (default `true`) and `togglePredictions(): void`; `<Predictions />` layer; `<VisitControls teamApiId={number} />`; group markers get `data-team-api-id` and a green check badge when visited in the current round; sidebar/E2E selectors rely on `data-team-api-id`.

- [ ] **Step 1: Layer toggle state** — `src/stores/layers.store.ts`

In `interface LayersState` add after `showGroupCircles: boolean;`:

```ts
  showPredictions: boolean;
```

and after `toggleGroupCircles: () => void;`:

```ts
  togglePredictions: () => void;
```

In the store initialiser add after `showGroupCircles: false,`:

```ts
      showPredictions: true,
```

and after the `toggleGroupCircles` implementation:

```ts
      togglePredictions: () => {
        set((state) => ({ showPredictions: !state.showPredictions }));
      },
```

(zustand `persist` merges persisted state over the initial state, so existing users get `showPredictions: true`.)

- [ ] **Step 2: Settings checkbox** — `src/components/Settings.tsx`

Add `showPredictions,` and `togglePredictions,` to the destructuring from `useLayersStore()` (after `toggleHomeCircle,`), and add directly after the `Groepen cirkels` `DropdownMenuCheckboxItem` (inside `DropdownMenuSubContent` of "Zichtbare lagen"):

```tsx
                                <DropdownMenuCheckboxItem checked={showPredictions}
                                                          onCheckedChange={togglePredictions}
                                                          onSelect={(e) => e.preventDefault()}>
                                    Voorspelling
                                </DropdownMenuCheckboxItem>
```

- [ ] **Step 3: Map layer** — `src/components/layers/Predictions.tsx`

```tsx
import { useMemo } from 'react';
import { Layer, Marker, Source } from 'react-map-gl/maplibre';
import type { FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { useAreas } from '@/hooks/areas.hook';
import { usePredictions } from '@/hooks/predictions.hook';
import { buildPredictionGeoJson } from '@/lib/prediction';
import { getColorFromArea } from '@/lib/utils';

// Routed zones get a solid border; estimates (straight-line fallback) and transit islands a dashed one
const SOLID_OUTLINE: FilterSpecification = ['all', ['!=', ['get', 'kind'], 'island'], ['==', ['get', 'estimate'], false]];
const DASHED_OUTLINE: FilterSpecification = ['any', ['==', ['get', 'kind'], 'island'], ['==', ['get', 'estimate'], true]];

export default function Predictions() {
  const { predictions } = usePredictions();
  const { hiddenAreas } = useAreas();

  const data = useMemo(
    () => buildPredictionGeoJson((predictions ?? []).filter((prediction) => !hiddenAreas.includes(prediction.area.toLowerCase())), getColorFromArea),
    [predictions, hiddenAreas],
  );

  return (
    <>
      <Source id="prediction-zones" type="geojson" data={data.zones}>
        <Layer
          id="prediction-zone-fill"
          type="fill"
          paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': ['match', ['get', 'kind'], 'core', 0.35, 0.15] }}
        />
        <Layer id="prediction-zone-outline" type="line" filter={SOLID_OUTLINE} paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5 }} />
        <Layer
          id="prediction-zone-outline-dashed"
          type="line"
          filter={DASHED_OUTLINE}
          paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [2, 2] }}
        />
      </Source>
      <Source id="prediction-lines" type="geojson" data={data.lines}>
        <Layer
          id="prediction-candidate-lines"
          type="line"
          layout={{ 'line-cap': 'round' }}
          paint={{
            'line-color': ['get', 'color'],
            'line-width': ['interpolate', ['linear'], ['get', 'probability'], 0, 1.5, 1, 5],
            'line-opacity': 0.85,
          }}
        />
      </Source>
      {data.labels.map((label) => (
        <Marker key={label.key} longitude={label.lng} latitude={label.lat} anchor="center">
          <span
            className="pointer-events-none whitespace-nowrap rounded-full border-2 bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-foreground shadow-sm"
            style={{ borderColor: label.color }}
          >
            {label.text}
          </span>
        </Marker>
      ))}
    </>
  );
}
```

- [ ] **Step 4: Render it** — `src/components/Map.tsx`

Add the import after `import HomeCircle from './layers/HomeCircle';`:

```tsx
import Predictions from './layers/Predictions';
```

Change the layers-store destructuring to:

```tsx
    const {showTeams, showDevices, showMarkersPart1, showMarkersPart2, showHomeCircle, showPredictions} = useLayersStore();
```

and render the layer before the teams (so zones sit under the group markers):

```tsx
                {showPredictions && <Predictions/>}
                {showTeams && <Teams/>}
```

(replace the existing single `{showTeams && <Teams/>}` line with these two lines).

- [ ] **Step 5: Visit controls** — `src/components/map/VisitControls.tsx`

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useVisits } from '@/hooks/predictions.hook';
import { visitSelection, visitStatusText } from '@/lib/prediction';
import type { VisitChoice } from '@/types/Prediction';

const OPTIONS: { value: VisitChoice; label: string }[] = [
  { value: 'visited', label: 'Bezocht' },
  { value: 'not_visited', label: 'Niet bezocht' },
  { value: 'auto', label: 'Automatisch' },
];

/** Visited / not visited / automatic buttons for a group (used in the group popup). */
export default function VisitControls({ teamApiId }: { teamApiId: number }) {
  const { visits, setVisit } = useVisits();
  const [busy, setBusy] = useState(false);
  const visit = visits?.find((candidate) => candidate.teamApiId === teamApiId);
  const selected = visitSelection(visit);

  async function choose(state: VisitChoice) {
    setBusy(true);
    try {
      await setVisit(teamApiId, state);
    } catch {
      toast.error('Bezoekstatus opslaan is mislukt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{visitStatusText(visit)}</p>
      <div className="grid grid-cols-3 gap-1">
        {OPTIONS.map((option) => (
          <Button
            key={option.value}
            size="xs"
            variant={selected === option.value ? 'default' : 'outline'}
            aria-pressed={selected === option.value}
            disabled={busy}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Badge and popup** — `src/components/layers/Teams.tsx`

Imports: add `CheckIcon` from `lucide-react` and the new pieces:

```tsx
import {CheckIcon} from 'lucide-react';
import {useVisits} from '@/hooks/predictions.hook';
import VisitControls from '../map/VisitControls';
```

Inside the component, after `const {areas} = useAreas();` add:

```tsx
    const {visits} = useVisits();
    const visitedIds = useMemo(
        () => new Set((visits ?? []).filter((visit) => visit.state === 'visited').map((visit) => visit.teamApiId)),
        [visits],
    );
```

Replace the marker body inside `<TooltipTrigger asChild>`:

```tsx
                                <div className="hover:brightness-125 hover:scale-105 transition-all ease-in-out">
                                    <MapMarker color={getColorFromArea(team.area || '')}/>
                                </div>
```

with:

```tsx
                                <div data-team-api-id={team.apiId}
                                     className="relative hover:brightness-125 hover:scale-105 transition-all ease-in-out">
                                    <MapMarker color={getColorFromArea(team.area || '')}/>
                                    {visitedIds.has(team.apiId) && (
                                        <span aria-label="Bezocht"
                                              className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-green-600 text-white ring-2 ring-white">
                                            <CheckIcon className="size-2.5" strokeWidth={3}/>
                                        </span>
                                    )}
                                </div>
```

Add `visitedIds` to the `useMemo` dependency array of `markers`:

```tsx
    }, [teams, isVisible, activeTeam, tooltipOpenId, showGroupCircles, handleMarkerTooltip, visitedIds]);
```

In the popup, directly before `{/* Select with areas */}`, add:

```tsx
                        {activeTeam.area && <VisitControls teamApiId={activeTeam.apiId}/>}
```

- [ ] **Step 7: Static checks** — `bun_ test`, `bun_ run build`, `bun_ run lint` → clean. If `tsc` rejects a paint expression literal, type the paint object with `import type { FillLayerSpecification, LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec'` (as `RulerControl.tsx` does) (`FillLayerSpecification['paint']` / `LineLayerSpecification['paint']`) instead of loosening to `any`. Fix react-hooks lint findings properly (no blanket disables).

- [ ] **Step 8: Commit**

```bash
git add src/components/layers/Predictions.tsx src/components/map/VisitControls.tsx src/stores/layers.store.ts src/components/Settings.tsx src/components/Map.tsx src/components/layers/Teams.tsx
git commit -m "feat(prediction): show prediction zones on the map and visit controls on groups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 11: "Voorspelling" sidebar section (client)

Run in `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client` with the client `bun_`.

**Files:**
- Create: `src/components/sidebar/PredictionList.tsx`
- Modify: `src/stores/sidebar.store.ts`, `src/components/sidebar/SidebarSections.tsx`

**Interfaces:**
- Consumes: `usePredictions` (Task 9); `accuracyLabel`, `candidateLabel`, `predictionStatusText`, `predictionSummary` (Task 9); `MapRef.flyTo` (`src/components/Map.tsx`); `SidebarSection`; `getColorFromArea`, `capitalizeFirstLetter`, `cn` (`src/lib/utils.ts`); `Skeleton`.
- Produces: `SidebarSectionId` gains `'predictions'` (default closed); `<PredictionList mapRef={RefObject<MapRef | null>} />` rows with `data-prediction-area="<area>"` (used by the E2E screenshots).

- [ ] **Step 1: Section id** — `src/stores/sidebar.store.ts`

Change the id union and defaults to:

```ts
export type SidebarSectionId = 'foxes' | 'hints' | 'predictions' | 'hintEntry' | 'counterHunt' | 'hunters';
```

```ts
const DEFAULT_OPEN_SECTIONS: Record<SidebarSectionId, boolean> = {
  foxes: true,
  hints: true,
  predictions: false,
  hintEntry: false,
  counterHunt: false,
  hunters: false,
};
```

(The existing `merge` spreads `DEFAULT_OPEN_SECTIONS` under the persisted value, so users with older persisted state get `predictions: false`.)

- [ ] **Step 2: Rows** — `src/components/sidebar/PredictionList.tsx`

```tsx
import { RefObject } from 'react';
import { FootprintsIcon, TrainFrontIcon, TriangleAlertIcon } from 'lucide-react';
import { MapRef } from '@/components/Map';
import { Skeleton } from '@/components/ui/skeleton';
import { usePredictions } from '@/hooks/predictions.hook';
import { accuracyLabel, candidateLabel, predictionStatusText } from '@/lib/prediction';
import { capitalizeFirstLetter, cn, getColorFromArea } from '@/lib/utils';
import type { Prediction } from '@/types/Prediction';

const FLY_TO_ZOOM = 13;

/** One row per fox team: top-1 group, probability, ETA, mode and accuracy; click flies to the zone. */
export default function PredictionList({ mapRef }: { mapRef: RefObject<MapRef | null> }) {
  const { predictions } = usePredictions();

  if (!predictions) {
    return (
      <div className="flex flex-col gap-1">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-9 rounded-md" />
        ))}
      </div>
    );
  }

  if (predictions.length === 0) {
    return <p className="text-xs text-muted-foreground">Nog geen voorspellingen.</p>;
  }

  function flyTo(prediction: Prediction) {
    if (!prediction.lastObservation) return;
    mapRef.current?.flyTo({ center: [prediction.lastObservation.lng, prediction.lastObservation.lat], zoom: FLY_TO_ZOOM, duration: 1500 });
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {predictions.map((prediction) => {
        const top = prediction.candidates[0];
        const status = predictionStatusText(prediction);
        return (
          <li key={prediction.area}>
            <button
              type="button"
              data-prediction-area={prediction.area}
              disabled={!prediction.lastObservation}
              onClick={() => flyTo(prediction)}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-xs',
                prediction.lastObservation ? 'cursor-pointer hover:bg-muted' : 'cursor-default',
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: getColorFromArea(prediction.area) }} />
                <span className="font-semibold">{capitalizeFirstLetter(prediction.area)}</span>
                {prediction.estimate && <span className="text-muted-foreground">(schatting)</span>}
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  {prediction.transitUnavailable && (
                    <TriangleAlertIcon className="size-3.5 text-amber-500" aria-label="OV-gegevens niet beschikbaar" />
                  )}
                  {prediction.mode === 'transit' ? (
                    <TrainFrontIcon className="size-3.5" aria-label="Lopen en openbaar vervoer" />
                  ) : (
                    <FootprintsIcon className="size-3.5" aria-label="Lopend" />
                  )}
                  {accuracyLabel(prediction.accuracy)}
                </span>
              </span>
              <span className={cn('truncate', status && 'text-muted-foreground')}>{status ?? `${top.name} · ${candidateLabel(top)}`}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 3: Place the section** — `src/components/sidebar/SidebarSections.tsx`

Add imports:

```tsx
import { usePredictions } from '@/hooks/predictions.hook';
import { predictionSummary } from '@/lib/prediction';
import PredictionList from './PredictionList';
```

Inside the component, after `const { devices } = useDevices();` add:

```tsx
  const { predictions } = usePredictions();
```

Between the `hints` section and the `hintEntry` section add:

```tsx
      <SidebarSection id="predictions" title="Voorspelling" summary={predictionSummary(predictions)}>
        <PredictionList mapRef={mapRef} />
      </SidebarSection>
```

- [ ] **Step 4: Static checks** — `bun_ test`, `bun_ run build`, `bun_ run lint` → clean (the `mapRef.current` read is inside an event handler, which the React Compiler rules allow).

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/PredictionList.tsx src/stores/sidebar.store.ts src/components/sidebar/SidebarSections.tsx
git commit -m "feat(prediction): add Voorspelling sidebar section

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 12: End-to-end verification on the local stack (server + client)

**Files:**
- Create: `src/scripts/seed-prediction.ts` (server); modify server `package.json` (script `seed-prediction`)
- Create (outside the repos, not committed): `/tmp/fox-e2e.override.yml`, `/tmp/shot/prediction.ts`
- Fix bugs found here in the relevant task's files and commit them as `fix(prediction): …` (with the trailer) in the repo they belong to.

**Interfaces:**
- Consumes: everything above; `predictionService`, `stopSource` (Task 8); `listPredictions` (Task 6); `refreshTransitStops` (Task 5); `moveM` (Task 1); selectors `data-prediction-area` (Task 11) and `data-team-api-id` (Task 10).
- Produces: `bun run seed-prediction [--force] [--clean]` — seeds 8 alpha groups (apiId 990000–990007) with 3 hourly hints and 4 oscar groups (apiId 990100–990103) with 2 recent spots, sets Alpha green / Oscar orange and recomputes both areas; `--clean` removes everything it created plus all predictions, learned models, routing cache and transit stops.

- [ ] **Step 1: Seed script** (server repo) — `src/scripts/seed-prediction.ts`

```ts
import mongoose from "mongoose";
import { Area } from "../models/area.model";
import { GroupVisit } from "../models/group-visit.model";
import { Marker, MarkerType } from "../models/marker.model";
import { Prediction } from "../models/prediction.model";
import { PredictionModel } from "../models/prediction-model.model";
import { RoutingCache } from "../models/routing-cache.model";
import { Team } from "../models/team.model";
import { TransitStop } from "../models/transit-stop.model";
import { moveM } from "../services/prediction/geo";
import { predictionService, stopSource } from "../services/prediction/instance";
import { listPredictions } from "../services/prediction/prediction.service";
import { refreshTransitStops } from "../services/prediction/transit-stop.service";
import type { LngLat } from "../services/prediction/types";

// Seeds synthetic fox-prediction data so the feature can be tried before the hunt:
// 8 alpha groups (apiId 990000+) with 3 hourly hints and 4 oscar groups (apiId 990100+) with 2 spots.
// Remove with: bun run seed-prediction --clean
// The Docker image sets NODE_ENV=production, so inside the container pass --force:
//   docker compose exec server bun run seed-prediction --force [--clean]
if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error("Refusing to seed fox prediction data with NODE_ENV=production. Pass --force to override.");
  process.exit(1);
}

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set");
  process.exit(1);
}
await mongoose.connect(uri);

const ALPHA_START: LngLat = [5.46, 52.08];
const ALPHA_GROUPS = [0, 120, -80, 100, -100, 60, -60, 0].map((northM, index) => moveM(ALPHA_START, 2000 * (index + 1), northM));
const ALPHA_HINTS: LngLat[] = [ALPHA_START, moveM(ALPHA_START, 2400, 60), moveM(ALPHA_START, 5600, -60)];
const OSCAR_GROUPS: LngLat[] = [
  [5.39, 52.175],
  [5.1214, 52.0907],
  [5.5582, 52.0271],
  [5.6668, 51.9693],
];
// The last spot is next to Amersfoort Centraal
const OSCAR_SPOTS: LngLat[] = [
  [5.4, 52.16],
  [5.374, 52.1532],
];
const SEEDED_POSITIONS = [...ALPHA_HINTS, ...OSCAR_SPOTS];

async function removeSeededMarkers() {
  await Marker.deleteMany({ $or: SEEDED_POSITIONS.map((position) => ({ "location.coordinates": position })) });
}

if (process.argv.includes("--clean")) {
  await Team.deleteMany({ apiId: { $gte: 990000 } });
  await removeSeededMarkers();
  await GroupVisit.deleteMany({ teamApiId: { $gte: 990000 } });
  await Promise.all([Prediction.deleteMany({}), PredictionModel.deleteMany({}), RoutingCache.deleteMany({}), TransitStop.deleteMany({})]);
  console.log("Removed seeded fox prediction data (teams, markers, visits, predictions, models, routing cache, transit stops)");
  await mongoose.disconnect();
  process.exit(0);
}

function team(apiId: number, area: string, [lng, lat]: LngLat, name: string) {
  return {
    apiId,
    name,
    accomodation: "Testclubhuis",
    street: "Teststraat",
    houseNumber: apiId % 100,
    postCode: "0000AA",
    city: "Teststad",
    area,
    location: { type: "Point", coordinates: [lng, lat] },
  };
}

const currentHour = new Date();
currentHour.setUTCMinutes(0, 0, 0);
const hoursAgo = (hours: number) => new Date(currentHour.getTime() - hours * 3_600_000);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

await Team.deleteMany({ apiId: { $gte: 990000 } });
await Team.insertMany([
  ...ALPHA_GROUPS.map((location, index) => team(990000 + index, "alpha", location, `Testgroep Alpha ${index + 1}`)),
  ...OSCAR_GROUPS.map((location, index) => team(990100 + index, "oscar", location, `Testgroep Oscar ${index + 1}`)),
]);
await removeSeededMarkers();
await Marker.insertMany([
  ...ALPHA_HINTS.map((position, index) => ({ area: "alpha", type: MarkerType.Hint, time: hoursAgo(2 - index), location: { type: "Point", coordinates: position } })),
  ...OSCAR_SPOTS.map((position, index) => ({ area: "oscar", type: MarkerType.Spot, time: minutesAgo(index === 0 ? 90 : 45), location: { type: "Point", coordinates: position } })),
]);
await Area.updateOne({ name: "Alpha" }, { $set: { status: "green", updatedAt: new Date() } }, { upsert: true });
await Area.updateOne({ name: "Oscar" }, { $set: { status: "orange", updatedAt: new Date() } }, { upsert: true });

try {
  console.log(`Transit stops stored: ${await refreshTransitStops(stopSource)}`);
} catch (error) {
  console.warn("Transit stops not fetched:", error instanceof Error ? error.message : error);
}

for (const area of ["alpha", "oscar"]) {
  const prediction = await predictionService.recomputeArea(area);
  console.log(`${area}: mode=${prediction.mode} estimate=${prediction.estimate} transitUnavailable=${prediction.transitUnavailable} round=${prediction.round}`);
  for (const candidate of prediction.candidates) {
    const via = candidate.transitLabel ? `transit (${candidate.transitLabel})` : candidate.via;
    console.log(`  ${candidate.name}: ${Math.round(candidate.probability * 100)}% via ${via}, eta ${candidate.eta.toISOString()}${candidate.overdue ? " (overdue)" : ""}`);
  }
}
console.log(`Stored predictions: ${(await listPredictions()).length}`);
await mongoose.disconnect();
process.exit(0);
```

In server `package.json` `scripts`, add after `"seed-hint"`: `"seed-prediction": "bun run src/scripts/seed-prediction.ts"` (add the comma to the preceding line).

Run `bun_ run typecheck` and `bun_ run lint` (server) → clean, then commit:

```bash
git add src/scripts/seed-prediction.ts package.json
git commit -m "chore(prediction): add seed script for local fox prediction testing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Rebuild with the Jotihunt areas cron disabled** (it would reset Alpha/Oscar to the real, red status every 10 s)

```bash
cat > /tmp/fox-e2e.override.yml <<'EOF'
services:
  server:
    environment:
      JOTIHUNT_API_URL: ""
EOF
cd "/home/silke/Documents/Jotihunt 2026"
docker compose -f docker-compose.yml -f /tmp/fox-e2e.override.yml up -d --build server client
sleep 10
docker compose logs server --since 1m | grep -i "JOTIHUNT_API_URL is not set"
```

Expected: `JOTIHUNT_API_URL is not set, skipping areas and articles cron jobs`.

- [ ] **Step 3: Seed**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose exec -T server bun run seed-prediction --force
```

Expected (numbers vary):
- `Transit stops stored: <n>` (or a `Transit stops not fetched` warning if Overpass is busy — oscar is in transit mode anyway);
- `alpha: mode=walking estimate=true transitUnavailable=false round=1` followed by 3 lines, the first `Testgroep Alpha 3` (the nearest unvisited group east of the last hint);
- `oscar: mode=transit estimate=true …` with up to 3 lines, some `via transit (bus …/trein …)` when Transitous has departures at that time (at night it may be walking only);
- `Stored predictions: 2` (or more once the cron has run).

`estimate=true` is expected locally because `ORS_API_KEY` is empty.

- [ ] **Step 4: API check**

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"solver@local.test","password":"Solver123456"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s localhost:3000/predictions -H "Authorization: Bearer $TOKEN" | python3 -c '
import json, sys
for p in json.load(sys.stdin):
    print(p["area"], p["status"], p["mode"], "estimate" if p["estimate"] else "", p.get("reason", ""), [(c["name"], round(c["probability"], 2), c["via"]) for c in p["candidates"]], len(p["zone"]["islands"]))'
curl -s localhost:3000/visits -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -30
```

Expected: `alpha green walking estimate` with 3 candidates; `oscar orange transit estimate`; other areas `Geen groepen gekoppeld`; `/visits` lists auto visits for 990000 and 990001 (round 1).

- [ ] **Step 5: Screenshots** — `/tmp/shot/prediction.ts`

```ts
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await page.setViewport({ width: 1280, height: 800 });
await page.goto("http://localhost:8080/login", { waitUntil: "networkidle2" });
const inputs = await page.$$("input");
await inputs[0].type("solver@local.test");
await inputs[1].type("Solver123456");
await page.click("button[type=submit]");
await wait(4000);

// Only the Voorspelling section open
await page.evaluate(() => {
  const stored = JSON.parse(localStorage.getItem("sidebar-storage") || '{"state":{},"version":1}');
  stored.state.openSections = { foxes: false, hints: false, predictions: true, hintEntry: false, counterHunt: false, hunters: false };
  localStorage.setItem("sidebar-storage", JSON.stringify(stored));
});
await page.goto("http://localhost:8080/", { waitUntil: "networkidle2" });
await wait(6000);
await page.screenshot({ path: "/out/pred-overview.png" });
const rows = await page.$$eval("[data-prediction-area]", (elements) => elements.map((element) => (element as HTMLElement).innerText.replace(/\s+/g, " ")));
console.log("rows:", JSON.stringify(rows));

await page.click('[data-prediction-area="alpha"]');
await wait(3500);
await page.screenshot({ path: "/out/pred-alpha.png" });

await page.click('[data-team-api-id="990003"]');
await wait(1500);
await page.screenshot({ path: "/out/pred-popup.png" });
for (const button of await page.$$(".maplibregl-popup-content button")) {
  if ((await button.evaluate((element) => (element as HTMLElement).innerText.trim())) === "Bezocht") {
    await button.click();
    break;
  }
}
await wait(2000);
await page.screenshot({ path: "/out/pred-popup-visited.png" });
console.log("badge:", await page.$eval('[data-team-api-id="990003"]', (element) => !!element.querySelector('[aria-label="Bezocht"]')));

await page.click('[data-prediction-area="oscar"]');
await wait(3500);
await page.screenshot({ path: "/out/pred-oscar.png" });
console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();
```

Run:

```bash
docker run --rm --network host -v /tmp/shot:/out -w /usr/src/app --entrypoint bun jotihunt-server /out/prediction.ts
```

Expected console output: `rows:` with 9 entries — `Alpha (schatting) … Testgroep Alpha 3 · NN% · ~HH:MM` and `top-3 –` (or `top-3 x/y`), `Oscar (schatting)` with the train icon, the rest `Geen groepen gekoppeld`; `badge: true`; `errors: []`.

- [ ] **Step 6: Review the screenshots** (open each PNG with the Read tool) and check:
  - `pred-overview.png`: "Voorspelling" section between "Hints" and "Hint registreren"; one row per area; alpha/oscar zones visible on the map in their area colours;
  - `pred-alpha.png`: core zone darker than the outer zone, **dashed** zone borders (estimate), lines from the last hint to 3 groups, labels like `62% · ~14:20`, visited groups 1–2 carry a green check badge;
  - `pred-popup.png`: group popup shows the status line (`Nog niet bezocht (automatisch)` or similar) and the three buttons `Bezocht` / `Niet bezocht` / `Automatisch` with `Automatisch` highlighted;
  - `pred-popup-visited.png`: `Bezocht` highlighted, status `Bezocht (handmatig, HH:MM) · ronde 1`, badge on the marker;
  - `pred-oscar.png`: oscar zone around Amersfoort Centraal; `🚆` label prefixes and dashed islands when Transitous returned itineraries;
  - Settings → "Zichtbare lagen" → unticking "Voorspelling" hides zones, lines and labels (check once manually in a browser at http://localhost:8080, or extend the script).

- [ ] **Step 7: Clean up and restore the normal stack**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose exec -T server bun run seed-prediction --force --clean
docker compose up -d server
sleep 15
docker compose exec -T mongodb mongosh jotihunt --quiet --eval \
  'printjson({teams: db.teams.countDocuments({apiId: {$gte: 990000}}), visits: db.groupvisits.countDocuments({teamApiId: {$gte: 990000}}), alpha: db.areas.findOne({name: "Alpha"}).status})'
rm /tmp/fox-e2e.override.yml
```

Expected: `Removed seeded fox prediction data …`; `{ teams: 0, visits: 0, alpha: 'red' }` (the areas cron is back and restored the real status).

- [ ] **Step 8: Final checks in both repos** — server: `bun_ test`, `bun_ run typecheck`, `bun_ run lint`; client: `bun_ test`, `bun_ run build`, `bun_ run lint` → all clean; `git status` clean in both repos.
