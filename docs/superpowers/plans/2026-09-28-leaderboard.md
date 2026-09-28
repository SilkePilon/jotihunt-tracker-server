# Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leaderboard of all hunters (score from hunts, hints and kilometres) with a 2-1-3 podium, a team stats strip and a list, opened from a "Leaderboard" button under "Alle hunts bekijken".

**Architecture:** Server: a pure scoring module (`leaderboard.helpers.ts`), a service that gathers users, hunt reports, solved hint cells and Traccar summaries (60 s in-memory cache), and `GET /leaderboard`. Client: pure helpers, an SWR hook, a responsive dialog/drawer with podium + list.

**Tech Stack:** Server Bun 1.4, Express 5, Mongoose 9, bun:test. Client React 19, Vite 8, Tailwind 4, shadcn new-york, SWR 2, vaul, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-28-leaderboard-design.md` (server repo).

## Global Constraints

- Repos: server `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server`, client `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`, branch `feat/leaderboard` in both (already checked out / created from `main`).
- Bun only via Docker, from the repo dir (full command each time):
  server: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network jotihunt_default -e MONGO_URI_TEST=mongodb://mongodb:27017/jotihunt-test -v "$PWD":/app -w /app oven/bun:1 bun <args>`
  client: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app oven/bun:1 bun <args>`
- Score: +2 per registered hunt report, + `site.points` of judged reports, +3 per solved hint cell (`claimedBy`), +1 per full 5 km of the user's own tracker in the distance window.
- Rank: score desc; equal scores share a place (1, 2, 2, 4); within a tie more hunts first, then name (nl locale compare).
- Distance window: `HUNT_START_TIME` … min(now, `HUNT_END_TIME`) when now ≥ start; otherwise start of today … now (`kind: "today"`).
- Names only in the API, never emails. UI copy Dutch. Server style double quotes/semicolons/printWidth 200; client single quotes/semicolons/printWidth 200.
- Client lint: React Compiler rules (no sync setState in effect bodies, no ref reads in render).
- Never print or log tokens. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.

---

### Task 1: Server — Traccar summary, scoring, service and route

**Files:**
- Modify: `src/services/traccar-api.ts` (+ `getSummary`), `src/services/traccar-api.test.ts`, `src/services/tracker-onboarding.service.test.ts` (fake gets `getSummary`)
- Create: `src/services/leaderboard.helpers.ts`, `src/services/leaderboard.helpers.test.ts`
- Create: `src/services/leaderboard.service.ts`, `src/services/leaderboard.service.test.ts`
- Create: `src/controllers/leaderboard.controller.ts`, `src/routes/leaderboard.route.ts`
- Modify: `src/index.ts` (mount `/leaderboard`)

**Interfaces:**
- Produces HTTP `GET /leaderboard` (auth) → `Leaderboard` (see types below).

- [ ] **Step 1: `getSummary` in the Traccar API**

In `TraccarApi` add:
```ts
  /** Distance (m) and top speed (knots) from the summary report, or null when the report has no row for the device. */
  getSummary(deviceId: number, from: Date, to: Date): Promise<{ distance: number; maxSpeed: number | null } | null>;
```
Implementation in `createTraccarApi`:
```ts
    async getSummary(deviceId, from, to) {
      const { data } = await http.get<{ deviceId: number; distance?: number; maxSpeed?: number }[]>("/api/reports/summary", {
        params: { deviceId, from: from.toISOString(), to: to.toISOString() },
        headers: { Accept: "application/json" },
      });
      const row = data.find((summary) => summary.deviceId === deviceId);
      if (!row) return null;
      return { distance: typeof row.distance === "number" ? row.distance : 0, maxSpeed: typeof row.maxSpeed === "number" ? row.maxSpeed : null };
    },
```
Test in `traccar-api.test.ts` (same style as the `getDistance` test): returns `{ distance, maxSpeed }`, `null` for no row, request `{ method: "get", url: "/api/reports/summary", params: { deviceId, from, to }, headers: { Accept: "application/json" } }`.
Add to the fake in `tracker-onboarding.service.test.ts`:
```ts
    async getSummary() {
      return null;
    },
```

- [ ] **Step 2: Failing tests for the scoring helpers** (`src/services/leaderboard.helpers.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { buildLeaderboard, distanceWindow, type DeviceSummary, type LeaderboardInput } from "./leaderboard.helpers";

const NOW = new Date("2026-10-17T15:00:00+02:00");
const START = "2026-10-17T10:00:00+02:00";
const END = "2026-10-18T12:00:00+02:00";

function input(overrides: Partial<LeaderboardInput> = {}): LeaderboardInput {
  return {
    users: [
      { id: "a", name: "Merida", deviceId: 1 },
      { id: "b", name: "Mulan", deviceId: 2 },
      { id: "c", name: "Admin" },
    ],
    reports: [],
    solvedBy: [],
    summaries: new Map<number, DeviceSummary>(),
    distanceAvailable: true,
    window: distanceWindow(NOW, START, END),
    now: NOW,
    ...overrides,
  };
}

describe("distanceWindow", () => {
  test("hunt window while the hunt runs", () => {
    expect(distanceWindow(NOW, START, END)).toEqual({ from: new Date(START), to: NOW, kind: "hunt" });
  });
  test("ends at HUNT_END_TIME after the hunt", () => {
    const after = new Date("2026-10-19T09:00:00+02:00");
    expect(distanceWindow(after, START, END)).toEqual({ from: new Date(START), to: new Date(END), kind: "hunt" });
  });
  test("today before the hunt or without a valid start", () => {
    const before = new Date("2026-09-28T15:00:00+02:00");
    const today = new Date(before);
    today.setHours(0, 0, 0, 0);
    expect(distanceWindow(before, START, END)).toEqual({ from: today, to: before, kind: "today" });
    expect(distanceWindow(before, undefined, undefined).kind).toBe("today");
    expect(distanceWindow(before, "nonsense", undefined).kind).toBe("today");
  });
});

describe("buildLeaderboard", () => {
  test("adds up hunts, judged points, hints and full 5 km blocks", () => {
    const board = buildLeaderboard(
      input({
        reports: [
          { reportedBy: "a", sitePoints: 10 },
          { reportedBy: "a", sitePoints: null },
          { reportedBy: "b", sitePoints: 0 },
        ],
        solvedBy: ["a", "b", "b"],
        summaries: new Map([
          [1, { distanceM: 14_900, maxSpeedKmh: 38 }],
          [2, { distanceM: 5_000, maxSpeedKmh: 92 }],
        ]),
      }),
    );
    const merida = board.entries.find((entry) => entry.name === "Merida")!;
    expect(merida).toMatchObject({ hunts: 2, approvedHunts: 1, huntPoints: 10, hints: 1, distanceKm: 14.9, topSpeedKmh: 38 });
    expect(merida.breakdown).toEqual({ hunts: 4, huntPoints: 10, hints: 3, distance: 2 });
    expect(merida.score).toBe(19);
    const mulan = board.entries.find((entry) => entry.name === "Mulan")!;
    expect(mulan.score).toBe(2 + 0 + 6 + 1);
    expect(board.totals).toEqual({ distanceKm: 19.9, hunts: 3, hints: 3, fastest: { name: "Mulan", speedKmh: 92 } });
  });

  test("users without a tracker or data get 0 and are still listed", () => {
    const board = buildLeaderboard(input());
    expect(board.entries.map((entry) => [entry.name, entry.score, entry.distanceKm, entry.topSpeedKmh])).toContainEqual(["Admin", 0, 0, null]);
    expect(board.entries).toHaveLength(3);
    expect(board.totals.fastest).toBeNull();
  });

  test("equal scores share a place; more hunts first, then name", () => {
    const board = buildLeaderboard(
      input({
        users: [
          { id: "a", name: "Zora" },
          { id: "b", name: "Anna" },
          { id: "c", name: "Bram" },
          { id: "d", name: "Cas" },
        ],
        reports: [{ reportedBy: "a", sitePoints: 1 }],
        solvedBy: ["b"],
      }),
    );
    // Zora 2+1=3 with 1 hunt, Anna 3 with 0 hunts, Bram 0, Cas 0
    expect(board.entries.map((entry) => [entry.name, entry.rank])).toEqual([
      ["Zora", 1],
      ["Anna", 1],
      ["Bram", 3],
      ["Cas", 3],
    ]);
  });

  test("passes window and availability through", () => {
    const board = buildLeaderboard(input({ distanceAvailable: false }));
    expect(board).toMatchObject({ distanceAvailable: false, distanceWindow: "hunt", distanceSince: new Date(START).toISOString(), updatedAt: NOW.toISOString() });
  });
});
```

- [ ] **Step 3: Run → FAIL (module missing).** `bun_ test src/services/leaderboard.helpers.test.ts`

- [ ] **Step 4: Implement `src/services/leaderboard.helpers.ts`**

```ts
import { startOfDay } from "./tracker-onboarding.helpers";

export const POINTS_PER_HUNT = 2;
export const POINTS_PER_HINT = 3;
export const KM_PER_POINT = 5;

export interface LeaderboardUser {
  id: string;
  name: string;
  /** Traccar device of the user's own "Mijn tracker" */
  deviceId?: number;
}
export interface LeaderboardReport {
  reportedBy: string;
  /** jotihunt.nl points once judged, else null */
  sitePoints: number | null;
}
export interface DeviceSummary {
  distanceM: number;
  maxSpeedKmh: number | null;
}
export interface DistanceWindow {
  from: Date;
  to: Date;
  kind: "hunt" | "today";
}
export interface LeaderboardInput {
  users: LeaderboardUser[];
  reports: LeaderboardReport[];
  /** One user id per solved hint cell */
  solvedBy: string[];
  summaries: Map<number, DeviceSummary>;
  distanceAvailable: boolean;
  window: DistanceWindow;
  now: Date;
}
export interface LeaderboardEntry {
  userId: string;
  name: string;
  rank: number;
  score: number;
  hunts: number;
  approvedHunts: number;
  huntPoints: number;
  hints: number;
  distanceKm: number;
  topSpeedKmh: number | null;
  breakdown: { hunts: number; huntPoints: number; hints: number; distance: number };
}
export interface Leaderboard {
  entries: LeaderboardEntry[];
  totals: { distanceKm: number; hunts: number; hints: number; fastest: { name: string; speedKmh: number } | null };
  distanceSince: string;
  distanceWindow: DistanceWindow["kind"];
  distanceAvailable: boolean;
  updatedAt: string;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Hunt window once the hunt has started, otherwise today (so the board can be tried before the weekend). */
export function distanceWindow(now: Date, start: string | undefined, end: string | undefined): DistanceWindow {
  const from = validDate(start);
  if (!from || now.getTime() < from.getTime()) return { from: startOfDay(now), to: now, kind: "today" };
  const until = validDate(end);
  return { from, to: until && until.getTime() < now.getTime() ? until : now, kind: "hunt" };
}

export function buildLeaderboard(input: LeaderboardInput): Leaderboard {
  const unranked = input.users.map((user) => {
    const reports = input.reports.filter((report) => report.reportedBy === user.id);
    const huntPoints = reports.reduce((sum, report) => sum + (report.sitePoints ?? 0), 0);
    const hints = input.solvedBy.filter((id) => id === user.id).length;
    const summary = user.deviceId !== undefined ? input.summaries.get(user.deviceId) : undefined;
    const distanceKm = round1((summary?.distanceM ?? 0) / 1000);
    const breakdown = {
      hunts: reports.length * POINTS_PER_HUNT,
      huntPoints,
      hints: hints * POINTS_PER_HINT,
      distance: Math.floor((summary?.distanceM ?? 0) / 1000 / KM_PER_POINT),
    };
    return {
      userId: user.id,
      name: user.name,
      rank: 0,
      score: breakdown.hunts + breakdown.huntPoints + breakdown.hints + breakdown.distance,
      hunts: reports.length,
      approvedHunts: reports.filter((report) => (report.sitePoints ?? 0) > 0).length,
      huntPoints,
      hints,
      distanceKm,
      topSpeedKmh: summary?.maxSpeedKmh ?? null,
      breakdown,
    };
  });

  const entries = unranked.sort((a, b) => b.score - a.score || b.hunts - a.hunts || a.name.localeCompare(b.name, "nl"));
  entries.forEach((entry, index) => {
    entry.rank = index > 0 && entries[index - 1].score === entry.score ? entries[index - 1].rank : index + 1;
  });

  const fastest = entries
    .filter((entry) => entry.topSpeedKmh !== null)
    .reduce<LeaderboardEntry | null>((best, entry) => (!best || entry.topSpeedKmh! > best.topSpeedKmh! ? entry : best), null);

  return {
    entries,
    totals: {
      distanceKm: round1(entries.reduce((sum, entry) => sum + entry.distanceKm, 0)),
      hunts: input.reports.length,
      hints: input.solvedBy.length,
      fastest: fastest ? { name: fastest.name, speedKmh: fastest.topSpeedKmh! } : null,
    },
    distanceSince: input.window.from.toISOString(),
    distanceWindow: input.window.kind,
    distanceAvailable: input.distanceAvailable,
    updatedAt: input.now.toISOString(),
  };
}
```
Note: `totals.hunts`/`hints` count everything (also reports/cells of deleted users). `totals.distanceKm` sums rounded entry values (test expects 19.9).

- [ ] **Step 5: Run → PASS.**

- [ ] **Step 6: Service** (`src/services/leaderboard.service.ts`)

```ts
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { HuntReport } from "../models/hunt-report.model";
import { User } from "../models/user.model";
import type { TraccarApi } from "./traccar-api";
import { buildLeaderboard, distanceWindow, type DeviceSummary, type Leaderboard } from "./leaderboard.helpers";

const KNOTS_TO_KMH = 1.852;
const CACHE_MS = 60_000;

export interface LeaderboardDeps {
  /** null when Traccar is not configured */
  api: TraccarApi | null;
  huntStart?: string;
  huntEnd?: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createLeaderboardService(deps: LeaderboardDeps) {
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; value: Leaderboard } | null = null;

  async function summaries(deviceIds: number[], from: Date, to: Date): Promise<{ map: Map<number, DeviceSummary>; available: boolean }> {
    const map = new Map<number, DeviceSummary>();
    if (!deps.api) return { map, available: false };
    const api = deps.api;
    let available = true;
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const summary = await api.getSummary(deviceId, from, to);
          if (summary) map.set(deviceId, { distanceM: summary.distance, maxSpeedKmh: summary.maxSpeed === null ? null : Math.round(summary.maxSpeed * KNOTS_TO_KMH) });
        } catch (error) {
          available = false;
          deps.onError?.(error);
        }
      }),
    );
    return { map, available };
  }

  async function get(): Promise<Leaderboard> {
    const current = now();
    if (cache && current.getTime() - cache.at < CACHE_MS) return cache.value;

    const [users, reports, solved] = await Promise.all([
      User.find({}, { name: 1, tracker: 1 }).lean(),
      HuntReport.find({}, { reportedBy: 1, site: 1 }).lean(),
      HintCell.find({ status: HintCellStatus.Solved, claimedBy: { $exists: true } }, { claimedBy: 1 }).lean(),
    ]);
    const window = distanceWindow(current, deps.huntStart, deps.huntEnd);
    const deviceIds = users.map((user) => user.tracker?.deviceId).filter((id): id is number => typeof id === "number");
    const { map, available } = await summaries(deviceIds, window.from, window.to);

    const value = buildLeaderboard({
      users: users.map((user) => ({ id: user._id.toString(), name: user.name, deviceId: user.tracker?.deviceId })),
      reports: reports.map((report) => ({ reportedBy: report.reportedBy.toString(), sitePoints: report.site ? report.site.points : null })),
      solvedBy: solved.map((cell) => cell.claimedBy!.toString()),
      summaries: map,
      distanceAvailable: available,
      window,
      now: current,
    });
    cache = { at: current.getTime(), value };
    return value;
  }

  return { get };
}
```

Service test (`src/services/leaderboard.service.test.ts`, test DB like `hunt-report.service.test.ts`): seed 2 users (one with `tracker: { deviceId: 5, uniqueId: "jh-x", vehicle: "car" }`), one HuntReport (create directly with `HuntReport.create({ area: "alpha", huntCode: "AB1", huntTime: new Date(), kind: "hunt", photo: "p.jpg", reportedBy, reportedByName: "Merida", site: { status: "Goedgekeurd", points: 10, seenAt: new Date() } })`), one solved HintCell (`HintCell.create({ articleId: 1, area: "alpha", publishAt: new Date(), slotTime: new Date(), status: "solved", claimedBy })`); fake api `getSummary` returning `{ distance: 10_000, maxSpeed: 20 }` → expect scores (Merida 2 + 10 + 3 + 2 = 17, maxSpeed 37 km/h), `distanceAvailable: true`; a second test with `getSummary` throwing → `distanceAvailable: false`, onError called, distance 0; a third: `api: null` → `distanceAvailable: false`; a fourth: two `get()` calls within 60 s with a changing fake `now` of +30 s call `getSummary` only once, +61 s calls again.

- [ ] **Step 7: Controller + route + mount**

`src/controllers/leaderboard.controller.ts`:
```ts
import { Request, Response } from "express";
import { logger } from "..";
import * as traccarrService from "../services/traccarr.service";
import { createTraccarApi } from "../services/traccar-api";
import { describeTraccarError, traccarHttp } from "../services/traccar-http";
import { createLeaderboardService } from "../services/leaderboard.service";

const leaderboard = createLeaderboardService({
  api: traccarrService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  huntStart: process.env.HUNT_START_TIME,
  huntEnd: process.env.HUNT_END_TIME,
  onError: (error) => logger.warn(`Leaderboard distances: ${describeTraccarError(error)}`),
});

export async function getLeaderboard(_req: Request, res: Response) {
  return res.status(200).json(await leaderboard.get());
}
```
`src/routes/leaderboard.route.ts`:
```ts
import express from "express";
import * as leaderboardController from "../controllers/leaderboard.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();
router.get("/", verifyToken, leaderboardController.getLeaderboard);
export default router;
```
`src/index.ts`: `import leaderboardRoute from "./routes/leaderboard.route";` and `app.use("/leaderboard", leaderboardRoute);` after `/hunt-reports`.

- [ ] **Step 8: Verify + commit.** `bun_ test`, `bun_ run typecheck`, `bun_ run lint` clean. Rebuild (`cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d --build server`), `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/leaderboard` → 401.
Commit: `feat(leaderboard): GET /leaderboard with scores from hunts, hints and kilometres`.

---

### Task 2: Client — types, helpers, hook, shared responsive dialog

**Files:**
- Create: `src/types/Leaderboard.ts`, `src/lib/leaderboard.ts`, `src/lib/leaderboard.test.ts`, `src/hooks/leaderboard.hook.ts`
- Move: `src/components/admin/AdminShell.tsx` → `src/components/ResponsiveDialog.tsx` (component renamed `ResponsiveDialog`, same props); update `HuntersDialog.tsx` and `UsersDialog.tsx` imports.

- [ ] **Step 1: Types** — mirror of the server `Leaderboard` / `LeaderboardEntry` (dates as ISO strings).

- [ ] **Step 2: Failing tests** (`src/lib/leaderboard.test.ts`) for:
  - `initials(name)`: first letters of the first two words, else the first two letters: `initials('Merida')` → `'Me'`, `initials('Test Admin')` → `'TA'`, `initials('')` → `'?'`.
  - `podiumOrder(entries)` → `[entries[1], entries[0], entries[2]]` filtered to existing (1 entry → `[undefined, e0, undefined]` rendered as gaps; return `(Entry | undefined)[]` of length 3).
  - `breakdownText(entry)` → `'Hunts 2 × 2 = 4 · jotihunt.nl 10 · Hints 1 × 3 = 3 · 14,9 km = 2'` (omit parts that are 0 except when everything is 0 → `'Nog geen punten'`).
  - `teamStripText(board)` → `'Samen: 19,9 km · 3 hunts · 3 hints · snelste: Mulan 92 km/u'`; leave out km when `distanceKm` is 0 and fastest when null; `'1 hunt'`/`'1 hint'` singular.
  - `windowText(board)` → hunt: `'Kilometers sinds za 17 okt 10:00'` (`toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })` — assert with the same call to avoid TZ issues); today: `'Kilometers van vandaag (de hunt is nog niet begonnen)'`; unavailable: `'Kilometers tijdelijk niet beschikbaar'`.
  Km formatting with `toLocaleString('nl-NL', { maximumFractionDigits: 1 })`.

- [ ] **Step 3: Implement `src/lib/leaderboard.ts`** to pass; **Step 4:** hook:
```ts
import { useAuthSWR } from '@/lib/swr';
import type { Leaderboard } from '@/types/Leaderboard';

/** Fetches only while the leaderboard is open; refreshes every minute. */
export const useLeaderboard = (enabled: boolean) => {
  const { data, error } = useAuthSWR<Leaderboard>(enabled ? '/leaderboard' : null, { refreshInterval: 60_000 });
  return { board: data, isLoading: enabled && !error && !data, isError: !!error };
};
```
- [ ] **Step 5:** Move/rename the shell; `bun test`, `bun run build`, `bun run lint` clean; commit `feat(leaderboard): client types, helpers and hook; shared ResponsiveDialog`.

---

### Task 3: Client — Leaderboard dialog UI and button

**Files:**
- Create: `src/components/leaderboard/LeaderboardDialog.tsx`, `src/components/leaderboard/Podium.tsx`, `src/components/leaderboard/LeaderboardRow.tsx`
- Modify: `src/components/hunts/HuntsSection.tsx` (button + dialog state)

- [ ] **Step 1: Button** in `HuntsSection` directly below "Alle hunts bekijken": `<Button variant="outline" size="sm" className="w-full" onClick={() => setLeaderboardOpen(true)}><TrophyIcon data-icon="inline-start" />Leaderboard</Button>` and render `<LeaderboardDialog open={leaderboardOpen} onOpenChange={setLeaderboardOpen} />`.

- [ ] **Step 2: `LeaderboardDialog`** — `ResponsiveDialog` with title "Leaderboard", description "Wie heeft dit weekend het meest bijgedragen?"; body (scrollable `min-h-0 flex-1 overflow-y-auto`): loading text "Laden...", error text "Leaderboard kon niet geladen worden.", else `<Podium>`, team strip (`teamStripText`, `text-sm text-muted-foreground text-center`), `<Separator />`, rows for entries from index 3, footer `windowText` (`text-xs text-muted-foreground`). Selected user id state for the breakdown (toggle on click). Current user id from `useAuthUser<User>()?._id`.

- [ ] **Step 3: `Podium`** — grid of 3 columns aligned to the bottom (`grid grid-cols-3 items-end gap-3`), order from `podiumOrder`. Each spot: optional 👑 for rank 1 (lucide `CrownIcon`, `text-amber-500`), avatar circle with `initials` (size-12 for #1, size-10 others; #1 `bg-primary/15 ring-2 ring-amber-400`), name (truncate), score (`font-semibold`, #1 `text-primary`), block with the rank number: heights `h-24` (#1), `h-16` (#2), `h-12` (#3); colours `bg-primary/20 text-primary` (#1), `bg-muted text-muted-foreground` (#2), `bg-orange-200/60 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200` (#3); `rounded-t-lg`. Show the rank from the entry (ties!). The spot is a button (aria-label `"{name}, plek {rank}, {score} punten"`) that toggles the breakdown under the podium (`breakdownText`). Current user's spot gets "(jij)" after the name.

- [ ] **Step 4: `LeaderboardRow`** — button row: rank (w-6, muted), avatar (size-8), name (+ " (jij)"), badges `Badge variant="secondary"`: `🎯 {hunts}`, `🧩 {hints}`, `🛣 {km} km` (hide km badge on phones when 0), score right (`tabular-nums font-semibold`). Current user row `bg-primary/10`. When selected, the breakdown text in a line below (`text-xs text-muted-foreground`).

- [ ] **Step 5:** build + lint + test; commit `feat(leaderboard): podium leaderboard dialog under Alle hunts bekijken`.

---

### Task 4: Verification

- [ ] Rebuild server + client. Seed demo data in the dev DB only for screenshots: 5 users via `docker compose exec -T server bun run create-user --email lb<N>@local.test --password Leader12345 --name <Name> --admin false` (Merida, Mulan, Moana, Tiana, Elsa) with `requiresPasswordChange:false`, a few hunt reports inserted directly in Mongo with `reportedBy` of those users (and `site.points` for some), and solved hint cells with `claimedBy`. Log in as one of them, open the leaderboard (desktop 1440×900 and mobile 390×844), screenshots to `/home/silke/Documents/Jotihunt 2026/.shots/leaderboard-desktop.png`, `leaderboard-mobile.png`, look at them.
- [ ] Clean up everything seeded (users `lb*@local.test`, their Traccar devices if created by logging in — find via `GET /api/devices?uniqueId=jh-<last 10 hex of user id>` with the token from `.env`, never printed — the seeded hunt reports and hint cells), confirm counts back to before.
- [ ] Final: server `bun test`/typecheck/lint, client `bun test`/build/lint.
