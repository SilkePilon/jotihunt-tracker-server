# Traccar Onboarding Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every logged-in user can connect their phone as a live GPS tracker from a "Mijn tracker" sidebar card: scan a QR code with the Traccar Client app (or tap a deep link on the phone), pick a vehicle, and see "Verbonden ✓" plus stats once positions arrive.

**Architecture:** Server: pure helpers (`tracker-onboarding.helpers.ts`: uniqueId, QR/deep-link URLs, vehicle → Traccar group, 5-minute connected rule, stats mapping) and a thin Traccar REST adapter (`traccar-api.ts`, over an injectable HTTP client; the real one is the shared axios instance in `traccar-http.ts`) feed `createTrackerOnboarding` (`tracker-onboarding.service.ts`), which lazily creates the user's Traccar device, moves it between groups and builds the status. `GET /tracker/me` and `PUT /tracker/me/vehicle` always answer 200 with `configured: false` + `reason` instead of 5xx when something is missing or Traccar is down. Client: an SWR hook (10 s / 30 s polling), pure label/QR helpers in `src/lib/tracker.ts`, a client-side SVG QR code (`qrcode` package), a shadcn `ToggleGroup` vehicle picker, the "Mijn tracker" section (auto open / collapse once) and a step-by-step guide dialog.

**Tech Stack:** Bun 1, Express 5, Mongoose 9, express-validator 7, axios (server); React 19, Vite 8, Tailwind 4 + shadcn/ui (new-york, `radix-ui` unified package), zustand 5, SWR 2.5, lucide-react, sonner, `qrcode` 1.5 (client).

**Spec:** `docs/superpowers/specs/2026-09-28-traccar-onboarding-design.md`

## Global Constraints

- Repos: `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server` and `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`, branch `feat/traccar-onboarding` in both (already checked out, stacked on `feat/fox-prediction`). Do not push. Each task header says which repo it runs in; run commands from that repo root.
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
- Server tests use **no network**: the Traccar API is injected (`TraccarApi` fake in service tests, fake `HttpClient` in adapter tests). The local Traccar container has no API token, so nothing may depend on live Traccar calls.
- Server files under `src/services/` and `src/models/` must **not** import `logger` from `".."` (that import boots the whole server). Only controllers/crons may. Because `traccarr.service.ts` imports the logger, the axios client moves to `src/services/traccar-http.ts` and the onboarding code never imports `traccarr.service.ts`.
- Spec values (copy exactly): uniqueId = `jh-` + last 10 hex chars of the user's `_id`; connected = device `lastUpdate` within **5 minutes**; speed knots × **1.852** → km/h; QR settings `accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true`; deep-link scheme `org.traccar.client://?url=<encoded server url>&id=…&<same settings>`; polling **10 s** while not connected, **30 s** when connected; QR ~**180 px** on a white tile; store links Google Play `org.traccar.client`, App Store `id843156974`; group ids from `GROUP_WALKING_ID`, `GROUP_BIKE_ID`, `GROUP_CAR_ID`, `GROUP_MOTORCYCLE_ID`; new env var `TRACCAR_CLIENT_URL` (e.g. `http://tracker.jouwscouting.nl:5055`).
- Texts (Dutch, exact): section title `Mijn tracker`; summaries `Verbonden ✓` / `Niet verbonden` / `Niet ingesteld`; `Scan deze code met de Traccar Client-app`; buttons `Open in Traccar-app`, `Uitleg stap voor stap`, `Opnieuw koppelen`; vehicles `Lopend` / `Fiets` / `Auto` / `Motor`; not configured `Live tracking is nog niet ingesteld.` (+ admins: `Vul TRACCAR_CLIENT_URL en de Traccar-token in .env in.`); stats `Laatste update`, `Snelheid`, `Batterij`, `Nauwkeurigheid`, `Afstand vandaag`.
- Client: UI copy Dutch. `bun test` only covers pure `src/lib/*.test.ts` (excluded from `tsc -b`); lib files used by tests use `import type` for type-only imports. React Compiler lint rules are strict: no ref reads during render, no synchronous `setState` in effects — use the render-time state-adjust pattern (as in `src/Layout.tsx`) or event handlers. New-york `Button` has `shrink-0`; use `flex-1` for side-by-side buttons. Dark mode through semantic tokens (`bg-card`, `text-muted-foreground`, …); the QR code itself is always black on white for scannability.
- Privacy: no email or other personal data in any outbound request. The QR code is generated in the browser (no QR web service). The only outbound calls go to the project's own self-hosted Traccar server.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Decisions where the spec is silent or ambiguous (decided here, do not re-litigate):
  1. **Latest position** is fetched with `GET /api/positions?id=<device.positionId>`: Traccar's OpenAPI says `deviceId` on `/api/positions` requires `from`/`to`. No `positionId` → no position stats.
  2. **Device lookup** always uses `GET /api/devices?uniqueId=` (the uniqueId is deterministic), so a device deleted in Traccar is simply not found and is recreated; the stored `tracker.deviceId` is refreshed when it changes. The Traccar token must belong to an admin (README says so).
  3. The device `name` is the user's display name (spec `POST /api/devices { name: user.name, … }`), because "Actieve hunters" shows Traccar device names. This goes only to the self-hosted Traccar; email is never sent anywhere.
  4. "No group" is `groupId: 0` (Traccar's convention); a vehicle whose `GROUP_*_ID` is empty/invalid moves the device out of any group. Existing devices without a stored vehicle get the vehicle from their group, else `walking`.
  5. `TRACCAR_CLIENT_URL` is normalised to `origin + path` (so `http://host:5055` becomes `http://host:5055/`); a non-http(s) value counts as not configured.
  6. `reason` codes: `client_url_missing`, `client_url_invalid`, `api_missing`, `unreachable`. `PUT /tracker/me/vehicle` with a valid body answers 200 with the same shape (also `configured: false` cases); invalid `vehicle` → 400 (express-validator). Traccar failures are logged as warnings by the controller via the `onError` callback.
  7. The shared axios client gets a **10 s timeout** so an unreachable Traccar turns into `unreachable` quickly.
  8. Service-level tests replace HTTP controller tests (the controller imports the logger, which boots the server); routes and validation are verified with curl in Task 4 and Task 8.
  9. Sidebar store default for `tracking` is **closed** (spec said "defaults (open)"): the section forces itself open while `connected === false`, so a default of open would only matter for users who are already connected — and the spec says the card is open *until* connected. Not-configured stays closed with the summary `Niet ingesteld`.
  10. Auto open/collapse lives in `TrackerSection` as local override state adjusted during render when `connected` changes (`sectionTransition`: unknown/true → false = open, false → true = close once); the store is only written when the user toggles. A disconnect during the session (true → false) opens the section again.
  11. Polling while `configured: false` is **60 s** (nothing changes quickly there).
  12. The guide dialog is rendered outside the Collapsible so it stays open (and shows the live "Verbonden ✓") when the section collapses on connect.
  13. After "Opnieuw koppelen" the card shows the QR view with an extra `Klaar` button that goes back to the stats.
  14. App Store link `https://apps.apple.com/app/id843156974`, Google Play `https://play.google.com/store/apps/details?id=org.traccar.client`.
  15. The deep-link button shows when `useIsMobile()` is true (viewport < 768 px), in the card and in guide step 2.

## File Structure

Server (`jotihunt-tracker-server/`):
- Create `src/services/tracker-onboarding.helpers.ts` (+ `.test.ts`) — pure: `Vehicle`, `VEHICLES`, `CLIENT_SETTINGS`, uniqueId, URL builders, vehicle groups, connected rule, stats mapping.
- Create `src/services/traccar-http.ts` — shared axios instance + `isTraccarConfigured` (no logger).
- Create `src/services/traccar-api.ts` (+ `.test.ts`) — `TraccarApi` interface and `createTraccarApi(http)` adapter.
- Create `src/services/tracker-onboarding.service.ts` (+ `.test.ts`) — `createTrackerOnboarding` (`ensureDevice`, `getMe`, `setVehicle`), `TrackerMe`.
- Modify `src/services/traccarr.service.ts` (use `traccar-http.ts`), `src/models/user.model.ts` (`tracker` subdoc), `src/controllers/tracker.controller.ts`, `src/routes/tracker.route.ts`, `src/index.ts`, `.env.example`, `README.md`.

Root (`/home/silke/Documents/Jotihunt 2026/`, not a git repo): modify `.env.example` and `.env` (add empty `TRACCAR_CLIENT_URL=`).

Client (`jotihunt-tracker-client/`):
- Create `src/types/Tracker.ts`, `src/lib/tracker.ts` (+ `src/lib/tracker.test.ts`), `src/hooks/tracker.hook.ts`.
- Create (shadcn CLI) `src/components/ui/toggle.tsx`, `src/components/ui/toggle-group.tsx`.
- Create `src/components/tracker/TrackerQrCode.tsx`, `src/components/tracker/VehiclePicker.tsx`, `src/components/tracker/TrackerGuideDialog.tsx`, `src/components/tracker/TrackerCard.tsx`, `src/components/sidebar/TrackerSection.tsx`.
- Modify `package.json` / `bun.lock` (`qrcode`, `@types/qrcode`), `eslint.config.js`, `src/stores/sidebar.store.ts`, `src/components/sidebar/SidebarSection.tsx`, `src/components/sidebar/SidebarSections.tsx`.

E2E helpers (outside the repos, not committed): `/tmp/fake-traccar/fake-traccar.ts`, `/tmp/tracker-e2e.override.yml`, `/tmp/shot/tracker.ts`.

Task order: 1–4 server, 5–7 client, 8 end-to-end.

---
### Task 1: Onboarding helpers (server)

**Files:**
- Create: `src/services/tracker-onboarding.helpers.ts`
- Test: `src/services/tracker-onboarding.helpers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Vehicle = "walking" | "bike" | "car" | "motorcycle"`, `VEHICLES: readonly Vehicle[]`, `DEFAULT_VEHICLE: Vehicle` (`"walking"`), `CONNECTED_WINDOW_MS` (300 000), `CLIENT_SETTINGS: Readonly<Record<string, string>>`
  - `type VehicleGroups = Record<Vehicle, number | undefined>`, `type NotConfiguredReason = "client_url_missing" | "client_url_invalid" | "api_missing" | "unreachable"`, `interface TrackerStats { lastUpdate?: string; speedKmh?: number; battery?: number; accuracyM?: number; distanceTodayM?: number }`
  - `deriveUniqueId(userId: string): string`, `normalizeClientUrl(value: string | undefined): string | null`, `buildQrUrl(clientUrl: string, uniqueId: string): string`, `buildDeepLink(clientUrl: string, uniqueId: string): string`
  - `vehicleGroupsFromEnv(env?: Record<string, string | undefined>): VehicleGroups`, `groupIdForVehicle(vehicle: Vehicle, groups: VehicleGroups): number` (0 = no group), `vehicleForGroupId(groupId: number | null | undefined, groups: VehicleGroups): Vehicle | undefined`
  - `isConnected(lastUpdate: string | Date | null | undefined, now: Date): boolean`, `startOfDay(now: Date): Date`
  - `interface StatsInput { lastUpdate?: string | Date | null; speed?: number | null; batteryLevel?: unknown; accuracy?: number | null; distanceTodayM?: number | null }`, `mapStats(input: StatsInput): TrackerStats`

- [ ] **Step 1: Write the failing test** — `src/services/tracker-onboarding.helpers.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import {
  buildDeepLink,
  buildQrUrl,
  deriveUniqueId,
  groupIdForVehicle,
  isConnected,
  mapStats,
  normalizeClientUrl,
  startOfDay,
  vehicleForGroupId,
  vehicleGroupsFromEnv,
} from "./tracker-onboarding.helpers";

const SETTINGS = "accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true";

describe("deriveUniqueId", () => {
  test("jh- plus the last 10 hex chars of the id, lowercase", () => {
    expect(deriveUniqueId("66F1A2B3C4D5E6F708192A3B")).toBe("jh-f708192a3b");
  });
});

describe("normalizeClientUrl", () => {
  test("keeps origin and path", () => {
    expect(normalizeClientUrl("http://tracker.jouwscouting.nl:5055")).toBe("http://tracker.jouwscouting.nl:5055/");
    expect(normalizeClientUrl(" https://example.nl/osmand ")).toBe("https://example.nl/osmand");
  });
  test("drops query and hash", () => {
    expect(normalizeClientUrl("http://example.nl:5055/?id=x#y")).toBe("http://example.nl:5055/");
  });
  test("missing or non-http values are null", () => {
    expect(normalizeClientUrl(undefined)).toBeNull();
    expect(normalizeClientUrl("")).toBeNull();
    expect(normalizeClientUrl("tracker.nl:5055")).toBeNull();
    expect(normalizeClientUrl("geen url")).toBeNull();
  });
});

describe("buildQrUrl / buildDeepLink", () => {
  test("QR = server url with id and settings as query", () => {
    expect(buildQrUrl("http://tracker.nl:5055/", "jh-0123456789")).toBe(`http://tracker.nl:5055/?id=jh-0123456789&${SETTINGS}`);
  });
  test("deep link encodes the server url in the url parameter", () => {
    expect(buildDeepLink("http://tracker.nl:5055/", "jh-0123456789")).toBe(
      `org.traccar.client://?url=http%3A%2F%2Ftracker.nl%3A5055%2F&id=jh-0123456789&${SETTINGS}`,
    );
  });
  test("deep link round-trips through URLSearchParams", () => {
    const link = buildDeepLink("https://example.nl/a b?", "jh-x");
    const params = new URLSearchParams(link.split("?").slice(1).join("?"));
    expect(params.get("url")).toBe("https://example.nl/a b?");
    expect(params.get("id")).toBe("jh-x");
  });
});

describe("vehicle groups", () => {
  const groups = vehicleGroupsFromEnv({ GROUP_WALKING_ID: "3", GROUP_BIKE_ID: "5", GROUP_CAR_ID: "", GROUP_MOTORCYCLE_ID: "abc" });

  test("parses positive integer ids, ignores empty/invalid ones", () => {
    expect(groups).toEqual({ walking: 3, bike: 5, car: undefined, motorcycle: undefined });
  });
  test("missing id maps to 0 (no group)", () => {
    expect(groupIdForVehicle("walking", groups)).toBe(3);
    expect(groupIdForVehicle("car", groups)).toBe(0);
  });
  test("reverse lookup", () => {
    expect(vehicleForGroupId(5, groups)).toBe("bike");
    expect(vehicleForGroupId(0, groups)).toBeUndefined();
    expect(vehicleForGroupId(99, groups)).toBeUndefined();
  });
});

describe("isConnected", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  test("within 5 minutes", () => {
    expect(isConnected("2026-10-17T11:55:00.000Z", now)).toBe(true);
    expect(isConnected(new Date("2026-10-17T11:59:30.000Z"), now)).toBe(true);
  });
  test("older, missing or invalid", () => {
    expect(isConnected("2026-10-17T11:54:59.000Z", now)).toBe(false);
    expect(isConnected(null, now)).toBe(false);
    expect(isConnected(undefined, now)).toBe(false);
    expect(isConnected("nope", now)).toBe(false);
  });
});

describe("startOfDay", () => {
  test("local midnight", () => {
    const start = startOfDay(new Date(2026, 9, 17, 14, 30));
    expect([start.getHours(), start.getMinutes(), start.getDate()]).toEqual([0, 0, 17]);
  });
});

describe("mapStats", () => {
  test("converts knots to km/h and rounds", () => {
    expect(
      mapStats({ lastUpdate: "2026-10-17T11:59:00Z", speed: 10, batteryLevel: 81.6, accuracy: 4.4, distanceTodayM: 12345.6 }),
    ).toEqual({ lastUpdate: "2026-10-17T11:59:00.000Z", speedKmh: 18.5, battery: 82, accuracyM: 4, distanceTodayM: 12346 });
  });
  test("omits missing and invalid fields", () => {
    expect(mapStats({ lastUpdate: null, speed: null, batteryLevel: "80", accuracy: 0 })).toEqual({});
    expect(mapStats({})).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun_ test src/services/tracker-onboarding.helpers.test.ts`
Expected: FAIL — `error: Cannot find module './tracker-onboarding.helpers'`.

- [ ] **Step 3: Implement** — `src/services/tracker-onboarding.helpers.ts`

```ts
/** Vehicle a hunter uses; drives the Traccar group (and so the map icon). */
export type Vehicle = "walking" | "bike" | "car" | "motorcycle";
export const VEHICLES: readonly Vehicle[] = ["walking", "bike", "car", "motorcycle"];
export const DEFAULT_VEHICLE: Vehicle = "walking";

/** A device counts as connected when Traccar received data within this window (same rule as "Actieve hunters"). */
export const CONNECTED_WINDOW_MS = 5 * 60 * 1000;
const KNOTS_TO_KMH = 1.852;

/** Traccar Client settings put in the QR code / deep link (the values the README recommends). */
export const CLIENT_SETTINGS: Readonly<Record<string, string>> = {
  accuracy: "highest",
  distance: "5",
  interval: "5",
  heartbeat: "30",
  buffer: "true",
  wakelock: "true",
  stop_detection: "true",
};

export type VehicleGroups = Record<Vehicle, number | undefined>;

export type NotConfiguredReason = "client_url_missing" | "client_url_invalid" | "api_missing" | "unreachable";

export interface TrackerStats {
  /** ISO time of the last data Traccar received */
  lastUpdate?: string;
  speedKmh?: number;
  /** Battery percentage (0-100) */
  battery?: number;
  accuracyM?: number;
  distanceTodayM?: number;
}

/** Stable, non-personal Traccar identifier for a user: `jh-` + the last 10 hex chars of the Mongo id. */
export function deriveUniqueId(userId: string): string {
  return `jh-${userId.slice(-10).toLowerCase()}`;
}

/**
 * Normalise TRACCAR_CLIENT_URL to `origin + path` (what the Traccar Client uses as server URL).
 * Returns null when the value is missing or not an http(s) URL.
 */
export function normalizeClientUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`;
}

/** QR payload: the server URL with the settings as query string (Traccar Client `applyUri`, http(s) branch). */
export function buildQrUrl(clientUrl: string, uniqueId: string): string {
  const params = new URLSearchParams({ id: uniqueId, ...CLIENT_SETTINGS });
  return `${clientUrl}?${params.toString()}`;
}

/** Deep link for phones: custom scheme, the server URL goes in the (encoded) `url` parameter. */
export function buildDeepLink(clientUrl: string, uniqueId: string): string {
  const params = new URLSearchParams({ url: clientUrl, id: uniqueId, ...CLIENT_SETTINGS });
  return `org.traccar.client://?${params.toString()}`;
}

function parseGroupId(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Traccar group ids per vehicle from GROUP_WALKING_ID / GROUP_BIKE_ID / GROUP_CAR_ID / GROUP_MOTORCYCLE_ID. */
export function vehicleGroupsFromEnv(env: Record<string, string | undefined> = process.env): VehicleGroups {
  return {
    walking: parseGroupId(env.GROUP_WALKING_ID),
    bike: parseGroupId(env.GROUP_BIKE_ID),
    car: parseGroupId(env.GROUP_CAR_ID),
    motorcycle: parseGroupId(env.GROUP_MOTORCYCLE_ID),
  };
}

/** Traccar uses groupId 0 for "no group". */
export function groupIdForVehicle(vehicle: Vehicle, groups: VehicleGroups): number {
  return groups[vehicle] ?? 0;
}

/** Reverse lookup for devices that already existed in Traccar; unknown group → undefined. */
export function vehicleForGroupId(groupId: number | null | undefined, groups: VehicleGroups): Vehicle | undefined {
  if (!groupId) return undefined;
  return VEHICLES.find((vehicle) => groups[vehicle] === groupId);
}

export function isConnected(lastUpdate: string | Date | null | undefined, now: Date): boolean {
  if (!lastUpdate) return false;
  const time = new Date(lastUpdate).getTime();
  if (Number.isNaN(time)) return false;
  return now.getTime() - time <= CONNECTED_WINDOW_MS;
}

/** Local midnight of `now` (the server runs with TZ=Europe/Amsterdam). */
export function startOfDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export interface StatsInput {
  lastUpdate?: string | Date | null;
  /** Knots, as Traccar reports it */
  speed?: number | null;
  batteryLevel?: unknown;
  accuracy?: number | null;
  distanceTodayM?: number | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Map raw Traccar values to display units; missing or invalid fields are omitted. */
export function mapStats(input: StatsInput): TrackerStats {
  const stats: TrackerStats = {};
  if (input.lastUpdate) {
    const time = new Date(input.lastUpdate);
    if (!Number.isNaN(time.getTime())) stats.lastUpdate = time.toISOString();
  }
  if (finite(input.speed)) stats.speedKmh = Math.round(input.speed * KNOTS_TO_KMH * 10) / 10;
  if (finite(input.batteryLevel)) stats.battery = Math.round(input.batteryLevel);
  if (finite(input.accuracy) && input.accuracy > 0) stats.accuracyM = Math.round(input.accuracy);
  if (finite(input.distanceTodayM)) stats.distanceTodayM = Math.round(input.distanceTodayM);
  return stats;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun_ test src/services/tracker-onboarding.helpers.test.ts`
Expected: `15 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/services/tracker-onboarding.helpers.ts src/services/tracker-onboarding.helpers.test.ts
git commit -m "feat(tracker): add Traccar onboarding helpers (uniqueId, QR/deep link, groups, stats)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: Traccar API adapter, shared HTTP client and `User.tracker` (server)

**Files:**
- Create: `src/services/traccar-http.ts`, `src/services/traccar-api.ts`
- Modify: `src/services/traccarr.service.ts:1-15`, `src/models/user.model.ts`
- Test: `src/services/traccar-api.test.ts`

**Interfaces:**
- Consumes: `VEHICLES` (Task 1).
- Produces:
  - `traccar-http.ts`: `isTraccarConfigured: boolean`, `traccarHttp: AxiosInstance` (baseURL `TRACCARR_API_URL`, Bearer `TRACCARR_API_TOKEN`, 10 s timeout).
  - `traccar-api.ts`: `interface HttpClient { get<T>(url, config?: { params?; headers? }): Promise<{ data: T }>; post<T>(url, body): Promise<{ data: T }>; put<T>(url, body): Promise<{ data: T }> }`, `interface TraccarDeviceDto { id: number; name: string; uniqueId: string; groupId?: number | null; positionId?: number | null; lastUpdate?: string | null; [key: string]: unknown }`, `interface TraccarPositionDto { id: number; deviceId: number; speed?: number | null; accuracy?: number | null; attributes?: { batteryLevel?: unknown } }`, `interface NewDevice { name: string; uniqueId: string; groupId: number }`, `interface TraccarApi { findDevice(uniqueId): Promise<TraccarDeviceDto | null>; createDevice(device: NewDevice): Promise<TraccarDeviceDto>; updateDevice(device: TraccarDeviceDto): Promise<TraccarDeviceDto>; getPosition(positionId: number): Promise<TraccarPositionDto | null>; getDistance(deviceId: number, from: Date, to: Date): Promise<number | null> }`, `createTraccarApi(http: HttpClient): TraccarApi`.
  - `User` schema: optional `tracker: { deviceId: number; uniqueId: string; vehicle: Vehicle }` (no `_id`); `UserType` picks it up via `InferSchemaType`.
  - `traccarr.service.ts` keeps exporting `isTraccarConfigured`, `getDevices`, `getPositions`, `getGroups` unchanged.

- [ ] **Step 1: Write the failing adapter test** — `src/services/traccar-api.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createTraccarApi, type HttpClient } from "./traccar-api";

interface Call {
  method: "get" | "post" | "put";
  url: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Fake HTTP client: records every call and answers with the queued responses in order. */
function fakeHttp(responses: unknown[]) {
  const calls: Call[] = [];
  const next = async <T>() => ({ data: responses.shift() as T });
  const http: HttpClient = {
    get: (url, config) => {
      calls.push({ method: "get", url, params: config?.params, headers: config?.headers });
      return next();
    },
    post: (url, body) => {
      calls.push({ method: "post", url, body });
      return next();
    },
    put: (url, body) => {
      calls.push({ method: "put", url, body });
      return next();
    },
  };
  return { http, calls };
}

describe("createTraccarApi", () => {
  test("findDevice queries by uniqueId and returns the exact match or null", async () => {
    const { http, calls } = fakeHttp([[{ id: 4, name: "A", uniqueId: "jh-1" }], []]);
    const api = createTraccarApi(http);
    expect(await api.findDevice("jh-1")).toEqual({ id: 4, name: "A", uniqueId: "jh-1" });
    expect(await api.findDevice("jh-2")).toBeNull();
    expect(calls[0]).toEqual({ method: "get", url: "/api/devices", params: { uniqueId: "jh-1" }, headers: undefined });
  });

  test("createDevice posts name, uniqueId and groupId", async () => {
    const { http, calls } = fakeHttp([{ id: 9, name: "Hunter", uniqueId: "jh-1", groupId: 3 }]);
    const created = await createTraccarApi(http).createDevice({ name: "Hunter", uniqueId: "jh-1", groupId: 3 });
    expect(created.id).toBe(9);
    expect(calls[0]).toEqual({ method: "post", url: "/api/devices", body: { name: "Hunter", uniqueId: "jh-1", groupId: 3 } });
  });

  test("updateDevice puts the full object to /api/devices/:id", async () => {
    const device = { id: 9, name: "Hunter", uniqueId: "jh-1", groupId: 5, phone: null, attributes: {} };
    const { http, calls } = fakeHttp([device]);
    await createTraccarApi(http).updateDevice(device);
    expect(calls[0]).toEqual({ method: "put", url: "/api/devices/9", body: device });
  });

  test("getPosition fetches by position id", async () => {
    const { http, calls } = fakeHttp([[{ id: 77, deviceId: 9, speed: 2 }], []]);
    const api = createTraccarApi(http);
    expect(await api.getPosition(77)).toEqual({ id: 77, deviceId: 9, speed: 2 });
    expect(await api.getPosition(78)).toBeNull();
    expect(calls[0].params).toEqual({ id: 77 });
  });

  test("getDistance asks the JSON summary report for the period", async () => {
    const { http, calls } = fakeHttp([[{ deviceId: 9, distance: 1234.5 }], []]);
    const api = createTraccarApi(http);
    const from = new Date("2026-10-16T22:00:00.000Z");
    const to = new Date("2026-10-17T10:00:00.000Z");
    expect(await api.getDistance(9, from, to)).toBe(1234.5);
    expect(await api.getDistance(9, from, to)).toBeNull();
    expect(calls[0]).toEqual({
      method: "get",
      url: "/api/reports/summary",
      params: { deviceId: 9, from: "2026-10-16T22:00:00.000Z", to: "2026-10-17T10:00:00.000Z" },
      headers: { Accept: "application/json" },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun_ test src/services/traccar-api.test.ts`
Expected: FAIL — `error: Cannot find module './traccar-api'`.

- [ ] **Step 3: Implement the adapter** — `src/services/traccar-api.ts`

```ts
/** Minimal HTTP surface the Traccar API needs (an axios instance satisfies it; tests pass a fake). */
export interface HttpClient {
  get<T>(url: string, config?: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<{ data: T }>;
  post<T>(url: string, body: unknown): Promise<{ data: T }>;
  put<T>(url: string, body: unknown): Promise<{ data: T }>;
}

/** The Traccar device fields this feature reads; the full object is kept so PUT can send it back unchanged. */
export interface TraccarDeviceDto {
  id: number;
  name: string;
  uniqueId: string;
  groupId?: number | null;
  positionId?: number | null;
  lastUpdate?: string | null;
  [key: string]: unknown;
}

export interface TraccarPositionDto {
  id: number;
  deviceId: number;
  speed?: number | null;
  accuracy?: number | null;
  attributes?: { batteryLevel?: unknown; [key: string]: unknown };
}

export interface NewDevice {
  name: string;
  uniqueId: string;
  groupId: number;
}

export interface TraccarApi {
  /** Device with this uniqueId, or null when Traccar has none (e.g. it was deleted). */
  findDevice(uniqueId: string): Promise<TraccarDeviceDto | null>;
  createDevice(device: NewDevice): Promise<TraccarDeviceDto>;
  /** PUT the full device object (Traccar replaces the whole record). */
  updateDevice(device: TraccarDeviceDto): Promise<TraccarDeviceDto>;
  /** A position by id (use the device's `positionId` for the latest one), or null. */
  getPosition(positionId: number): Promise<TraccarPositionDto | null>;
  /** Distance in metres from the summary report, or null when the report has no row. */
  getDistance(deviceId: number, from: Date, to: Date): Promise<number | null>;
}

export function createTraccarApi(http: HttpClient): TraccarApi {
  return {
    async findDevice(uniqueId) {
      const { data } = await http.get<TraccarDeviceDto[]>("/api/devices", { params: { uniqueId } });
      return data.find((device) => device.uniqueId === uniqueId) ?? null;
    },
    async createDevice(device) {
      const { data } = await http.post<TraccarDeviceDto>("/api/devices", device);
      return data;
    },
    async updateDevice(device) {
      const { data } = await http.put<TraccarDeviceDto>(`/api/devices/${device.id}`, device);
      return data;
    },
    async getPosition(positionId) {
      const { data } = await http.get<TraccarPositionDto[]>("/api/positions", { params: { id: positionId } });
      return data[0] ?? null;
    },
    async getDistance(deviceId, from, to) {
      const { data } = await http.get<{ deviceId: number; distance?: number }[]>("/api/reports/summary", {
        params: { deviceId, from: from.toISOString(), to: to.toISOString() },
        headers: { Accept: "application/json" },
      });
      const row = data.find((summary) => summary.deviceId === deviceId);
      return typeof row?.distance === "number" ? row.distance : null;
    },
  };
}
```

- [ ] **Step 4: Shared axios client** — `src/services/traccar-http.ts`

```ts
import axios from "axios";

// Shared axios client for the Traccar REST API. Kept free of the logger import so services can use it.
const apiUrl = process.env.TRACCARR_API_URL;
const apiToken = process.env.TRACCARR_API_TOKEN;

export const isTraccarConfigured = Boolean(apiUrl && apiToken);

export const traccarHttp = axios.create({
  baseURL: apiUrl,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${apiToken}`,
  },
});
```

In `src/services/traccarr.service.ts` replace the top of the file (the `axios`/`logger` imports, `apiUrl`, `apiToken`, `isTraccarConfigured` and the `axios.create(…)` block — everything above the `/** API interface for a Traccar position. */` comment) with:

```ts
import { logger } from "..";
import { traccarHttp as apiClient } from "./traccar-http";

export { isTraccarConfigured } from "./traccar-http";
```

The rest of the file (interfaces, `getDevices`, `getPositions`, `getGroups` using `apiClient`) stays as it is.

- [ ] **Step 5: `tracker` subdocument on the user** — `src/models/user.model.ts` (full file)

```ts
import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { VEHICLES } from "../services/tracker-onboarding.helpers";

/** The user's own Traccar device (created lazily by GET /tracker/me). */
const TrackerSchema = new mongoose.Schema(
  {
    deviceId: { type: Number, required: true },
    uniqueId: { type: String, required: true },
    vehicle: { type: String, enum: VEHICLES, required: true },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  admin: {
    type: Boolean,
    default: false,
    required: true,
  },
  requiresPasswordChange: {
    type: Boolean,
    default: true,
    required: true,
  },
  tracker: {
    type: TrackerSchema,
    required: false,
  },
});

// Exclude password from JSON response
UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.password;
    return ret;
  },
});

export const User = mongoose.model("User", UserSchema);
export type UserType = HydratedDocument<InferSchemaType<typeof UserSchema>>;
```

- [ ] **Step 6: Run tests and static checks**

Run: `bun_ test src/services/traccar-api.test.ts && bun_ run typecheck && bun_ run lint`
Expected: `5 pass`, `0 fail`; `tsc --noEmit` and `eslint .` print no errors (an axios instance must be assignable to `HttpClient`; Task 4 relies on that).

- [ ] **Step 7: Commit**

```bash
git add src/services/traccar-http.ts src/services/traccar-api.ts src/services/traccar-api.test.ts src/services/traccarr.service.ts src/models/user.model.ts
git commit -m "feat(tracker): add Traccar REST adapter and tracker subdocument on users

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: Onboarding service (server)

**Files:**
- Create: `src/services/tracker-onboarding.service.ts`
- Test: `src/services/tracker-onboarding.service.test.ts`

**Interfaces:**
- Consumes: everything from Task 1; `TraccarApi`, `TraccarDeviceDto`, `NewDevice`, `TraccarPositionDto` (Task 2); `User`, `UserType` (Task 2); `connectTestDb`, `clearTestDb`, `disconnectTestDb` from `src/test/db.ts`.
- Produces:
  - `type TrackerMe = { configured: false; reason: NotConfiguredReason; connected: false } | { configured: true; qrUrl: string; deepLink: string; uniqueId: string; vehicle: Vehicle; connected: boolean; stats: TrackerStats }`
  - `interface TrackerOnboardingDeps { api: TraccarApi | null; clientUrl: string | undefined; groups: VehicleGroups; now?: () => Date; onError?: (error: unknown) => void }`
  - `createTrackerOnboarding(deps)` → `{ ensureDevice(user: UserType): Promise<{ device: TraccarDeviceDto; vehicle: Vehicle }>; getMe(user: UserType): Promise<TrackerMe>; setVehicle(user: UserType, vehicle: Vehicle): Promise<TrackerMe> }`; `getMe`/`setVehicle` never throw for configuration or Traccar errors. `type TrackerOnboarding = ReturnType<typeof createTrackerOnboarding>`.

- [ ] **Step 1: Write the failing test** — `src/services/tracker-onboarding.service.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import type { NewDevice, TraccarApi, TraccarDeviceDto, TraccarPositionDto } from "./traccar-api";
import { deriveUniqueId, type VehicleGroups } from "./tracker-onboarding.helpers";
import { createTrackerOnboarding } from "./tracker-onboarding.service";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const GROUPS: VehicleGroups = { walking: 3, bike: 5, car: 2, motorcycle: undefined };
const CLIENT_URL = "http://tracker.test:5055";
const SETTINGS = "accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true";

/** In-memory Traccar: devices by id, positions by id, one distance per device; records every call. */
function fakeTraccar() {
  const devices = new Map<number, TraccarDeviceDto>();
  const positions = new Map<number, TraccarPositionDto>();
  const distances = new Map<number, number>();
  const calls: string[] = [];
  let nextId = 100;
  let down = false;
  const guard = () => {
    if (down) throw new Error("connect ECONNREFUSED");
  };
  const api: TraccarApi = {
    async findDevice(uniqueId) {
      calls.push(`find ${uniqueId}`);
      guard();
      return [...devices.values()].find((device) => device.uniqueId === uniqueId) ?? null;
    },
    async createDevice(input: NewDevice) {
      calls.push(`create ${input.name} ${input.uniqueId} ${input.groupId}`);
      guard();
      const device: TraccarDeviceDto = { id: nextId++, ...input, positionId: null, lastUpdate: null, status: "unknown" };
      devices.set(device.id, device);
      return device;
    },
    async updateDevice(device) {
      calls.push(`update ${device.id} ${device.groupId}`);
      guard();
      devices.set(device.id, device);
      return device;
    },
    async getPosition(positionId) {
      calls.push(`position ${positionId}`);
      guard();
      return positions.get(positionId) ?? null;
    },
    async getDistance(deviceId, from, to) {
      calls.push(`distance ${deviceId} ${from.toISOString()} ${to.toISOString()}`);
      guard();
      if (!distances.has(deviceId)) throw new Error("report failed");
      return distances.get(deviceId)!;
    },
  };
  return {
    api,
    devices,
    positions,
    distances,
    calls,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

async function makeUser() {
  return User.create({ email: "hunter@local.test", password: "x", name: "Hunter Een" });
}

/** `clientUrl: null` simulates an unset TRACCAR_CLIENT_URL. */
function service(traccar: ReturnType<typeof fakeTraccar> | null, clientUrl: string | null = CLIENT_URL) {
  const errors: unknown[] = [];
  const onboarding = createTrackerOnboarding({
    api: traccar?.api ?? null,
    clientUrl: clientUrl ?? undefined,
    groups: GROUPS,
    now: () => NOW,
    onError: (error) => errors.push(error),
  });
  return { onboarding, errors };
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("configuration", () => {
  test("missing, invalid client url and missing API give configured:false with a reason", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    expect(await service(traccar, null).onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_missing", connected: false });
    expect(await service(traccar, "  ").onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_missing", connected: false });
    expect(await service(traccar, "tracker.test:5055").onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_invalid", connected: false });
    expect(await service(null).onboarding.getMe(user)).toEqual({ configured: false, reason: "api_missing", connected: false });
    expect(await service(null).onboarding.setVehicle(user, "bike")).toEqual({ configured: false, reason: "api_missing", connected: false });
    expect(traccar.calls).toEqual([]);
  });

  test("Traccar down gives configured:false 'unreachable' and reports the error", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    traccar.setDown(true);
    const { onboarding, errors } = service(traccar);
    expect(await onboarding.getMe(user)).toEqual({ configured: false, reason: "unreachable", connected: false });
    expect(await onboarding.setVehicle(user, "car")).toEqual({ configured: false, reason: "unreachable", connected: false });
    expect(errors).toHaveLength(2);
  });
});

describe("getMe", () => {
  test("creates the device lazily in the walking group and stores it on the user", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    const me = await service(traccar).onboarding.getMe(user);

    expect(me).toEqual({
      configured: true,
      qrUrl: `http://tracker.test:5055/?id=${uniqueId}&${SETTINGS}`,
      deepLink: `org.traccar.client://?url=http%3A%2F%2Ftracker.test%3A5055%2F&id=${uniqueId}&${SETTINGS}`,
      uniqueId,
      vehicle: "walking",
      connected: false,
      stats: {},
    });
    expect(traccar.calls.slice(0, 2)).toEqual([`find ${uniqueId}`, `create Hunter Een ${uniqueId} 3`]);
    const stored = await User.findById(user._id).lean();
    expect(stored?.tracker).toEqual({ deviceId: 100, uniqueId, vehicle: "walking" });
  });

  test("reuses an existing device and does not create a second one", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.getMe(user);
    expect(traccar.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(traccar.devices.size).toBe(1);
  });

  test("adopts a device that already existed in Traccar, taking the vehicle from its group", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Oud", uniqueId, groupId: 5, positionId: null, lastUpdate: null });
    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({ configured: true, vehicle: "bike" });
    expect(traccar.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect((await User.findById(user._id).lean())?.tracker).toEqual({ deviceId: 7, uniqueId, vehicle: "bike" });
  });

  test("recreates the device when it was deleted in Traccar, keeping the chosen vehicle", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.setVehicle(user, "car");
    traccar.devices.clear();

    const me = await onboarding.getMe(user);
    expect(me).toMatchObject({ configured: true, vehicle: "car" });
    expect(traccar.calls.filter((call) => call.startsWith("create"))).toEqual([
      `create Hunter Een ${deriveUniqueId(user._id.toString())} 3`,
      `create Hunter Een ${deriveUniqueId(user._id.toString())} 2`,
    ]);
    expect((await User.findById(user._id).lean())?.tracker?.deviceId).toBe(101);
  });

  test("connected with stats when the device reported within 5 minutes", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Hunter Een", uniqueId, groupId: 3, positionId: 70, lastUpdate: "2026-10-17T11:58:00.000Z" });
    traccar.positions.set(70, { id: 70, deviceId: 7, speed: 2.5, accuracy: 6.2, attributes: { batteryLevel: 76 } });
    traccar.distances.set(7, 4321.4);

    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({
      configured: true,
      connected: true,
      stats: { lastUpdate: "2026-10-17T11:58:00.000Z", speedKmh: 4.6, battery: 76, accuracyM: 6, distanceTodayM: 4321 },
    });
    const from = new Date(NOW);
    from.setHours(0, 0, 0, 0);
    expect(traccar.calls).toContain(`distance 7 ${from.toISOString()} ${NOW.toISOString()}`);
  });

  test("not connected after 5 minutes; a failing summary report only drops the distance", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Hunter Een", uniqueId, groupId: 3, positionId: 70, lastUpdate: "2026-10-17T11:54:00.000Z" });
    traccar.positions.set(70, { id: 70, deviceId: 7, speed: 0, accuracy: 12 });

    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({ connected: false, stats: { lastUpdate: "2026-10-17T11:54:00.000Z", speedKmh: 0, accuracyM: 12 } });
    expect(me.configured && me.stats.distanceTodayM).toBeUndefined();
  });
});

describe("setVehicle", () => {
  test("PUTs the full device with the new group and stores the vehicle", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);

    const me = await onboarding.setVehicle(user, "bike");
    expect(me).toMatchObject({ configured: true, vehicle: "bike" });
    expect(traccar.calls).toContain("update 100 5");
    expect(traccar.devices.get(100)).toMatchObject({ id: 100, name: "Hunter Een", status: "unknown", groupId: 5 });
    expect((await User.findById(user._id).lean())?.tracker?.vehicle).toBe("bike");
  });

  test("vehicle without a configured group moves the device out of its group (groupId 0)", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.setVehicle(user, "motorcycle");
    expect(traccar.devices.get(100)?.groupId).toBe(0);
  });

  test("same group: no PUT", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.setVehicle(user, "walking");
    expect(traccar.calls.some((call) => call.startsWith("update"))).toBe(false);
  });
});

describe("User.tracker", () => {
  test("rejects an unknown vehicle", async () => {
    const user = await makeUser();
    user.set("tracker", { deviceId: 1, uniqueId: "jh-1", vehicle: "boat" });
    await expect(user.save()).rejects.toThrow();
  });

  test("is left out when not set", async () => {
    const user = await makeUser();
    expect(user.toJSON().tracker).toBeUndefined();
    expect(user.toJSON().password).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun_ test src/services/tracker-onboarding.service.test.ts`
Expected: FAIL — `error: Cannot find module './tracker-onboarding.service'`.

- [ ] **Step 3: Implement** — `src/services/tracker-onboarding.service.ts`

```ts
import type { UserType } from "../models/user.model";
import type { TraccarApi, TraccarDeviceDto } from "./traccar-api";
import {
  buildDeepLink,
  buildQrUrl,
  DEFAULT_VEHICLE,
  deriveUniqueId,
  groupIdForVehicle,
  isConnected,
  mapStats,
  normalizeClientUrl,
  startOfDay,
  vehicleForGroupId,
  type NotConfiguredReason,
  type TrackerStats,
  type Vehicle,
  type VehicleGroups,
} from "./tracker-onboarding.helpers";

export type TrackerMe =
  | { configured: false; reason: NotConfiguredReason; connected: false }
  | {
      configured: true;
      qrUrl: string;
      deepLink: string;
      uniqueId: string;
      vehicle: Vehicle;
      connected: boolean;
      stats: TrackerStats;
    };

export interface TrackerOnboardingDeps {
  /** null when TRACCARR_API_URL / TRACCARR_API_TOKEN are missing */
  api: TraccarApi | null;
  /** Raw TRACCAR_CLIENT_URL */
  clientUrl: string | undefined;
  groups: VehicleGroups;
  now?: () => Date;
  /** Called when Traccar fails (the controller logs it); the response then says `unreachable`. */
  onError?: (error: unknown) => void;
}

export interface EnsuredDevice {
  device: TraccarDeviceDto;
  vehicle: Vehicle;
}

const notConfigured = (reason: NotConfiguredReason): TrackerMe => ({ configured: false, reason, connected: false });

export function createTrackerOnboarding(deps: TrackerOnboardingDeps) {
  const now = deps.now ?? (() => new Date());
  const clientUrl = normalizeClientUrl(deps.clientUrl);

  /** Why the card can't be used, or null when everything is configured. */
  function configurationProblem(): NotConfiguredReason | null {
    if (!deps.clientUrl?.trim()) return "client_url_missing";
    if (!clientUrl) return "client_url_invalid";
    if (!deps.api) return "api_missing";
    return null;
  }

  function requireApi(): TraccarApi {
    if (!deps.api) throw new Error("Traccar API is not configured");
    return deps.api;
  }

  /**
   * Make sure the user's Traccar device exists: look it up by its (deterministic) uniqueId and create it when
   * missing, also when it was deleted in Traccar. Stores `{ deviceId, uniqueId, vehicle }` on the user.
   */
  async function ensureDevice(user: UserType): Promise<EnsuredDevice> {
    const api = requireApi();
    const uniqueId = deriveUniqueId(user._id.toString());
    const storedVehicle = user.tracker?.vehicle as Vehicle | undefined;
    let device = await api.findDevice(uniqueId);
    if (!device) {
      device = await api.createDevice({
        name: user.name,
        uniqueId,
        groupId: groupIdForVehicle(storedVehicle ?? DEFAULT_VEHICLE, deps.groups),
      });
    }
    const vehicle = storedVehicle ?? vehicleForGroupId(device.groupId, deps.groups) ?? DEFAULT_VEHICLE;
    if (user.tracker?.deviceId !== device.id || user.tracker?.uniqueId !== uniqueId || user.tracker?.vehicle !== vehicle) {
      user.tracker = { deviceId: device.id, uniqueId, vehicle };
      await user.save();
    }
    return { device, vehicle };
  }

  /** Connected flag and stats; position and distance failures only drop those stats. */
  async function status(device: TraccarDeviceDto): Promise<{ connected: boolean; stats: TrackerStats }> {
    const api = requireApi();
    const current = now();
    const [position, distance] = await Promise.all([
      device.positionId ? api.getPosition(device.positionId).catch(() => null) : Promise.resolve(null),
      api.getDistance(device.id, startOfDay(current), current).catch(() => null),
    ]);
    return {
      connected: isConnected(device.lastUpdate, current),
      stats: mapStats({
        lastUpdate: device.lastUpdate,
        speed: position?.speed,
        batteryLevel: position?.attributes?.batteryLevel,
        accuracy: position?.accuracy,
        distanceTodayM: distance,
      }),
    };
  }

  async function describe(ensured: EnsuredDevice): Promise<TrackerMe> {
    const uniqueId = ensured.device.uniqueId;
    return {
      configured: true,
      qrUrl: buildQrUrl(clientUrl!, uniqueId),
      deepLink: buildDeepLink(clientUrl!, uniqueId),
      uniqueId,
      vehicle: ensured.vehicle,
      ...(await status(ensured.device)),
    };
  }

  /** GET /tracker/me: creates the device lazily; never throws for configuration or Traccar problems. */
  async function getMe(user: UserType): Promise<TrackerMe> {
    const problem = configurationProblem();
    if (problem) return notConfigured(problem);
    try {
      return await describe(await ensureDevice(user));
    } catch (error) {
      deps.onError?.(error);
      return notConfigured("unreachable");
    }
  }

  /** PUT /tracker/me/vehicle: moves the device to the vehicle's Traccar group and remembers the choice. */
  async function setVehicle(user: UserType, vehicle: Vehicle): Promise<TrackerMe> {
    const problem = configurationProblem();
    if (problem) return notConfigured(problem);
    try {
      const ensured = await ensureDevice(user);
      const groupId = groupIdForVehicle(vehicle, deps.groups);
      let device = ensured.device;
      if ((device.groupId ?? 0) !== groupId) {
        device = await requireApi().updateDevice({ ...device, groupId });
      }
      if (user.tracker && user.tracker.vehicle !== vehicle) {
        user.tracker.vehicle = vehicle;
        await user.save();
      }
      return await describe({ device, vehicle });
    } catch (error) {
      deps.onError?.(error);
      return notConfigured("unreachable");
    }
  }

  return { ensureDevice, getMe, setVehicle };
}

export type TrackerOnboarding = ReturnType<typeof createTrackerOnboarding>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun_ test src/services/tracker-onboarding.service.test.ts`
Expected: `13 pass`, `0 fail`.

- [ ] **Step 5: Full server suite and static checks**

Run: `bun_ test && bun_ run typecheck && bun_ run lint`
Expected: all tests pass (`0 fail`), no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/tracker-onboarding.service.ts src/services/tracker-onboarding.service.test.ts
git commit -m "feat(tracker): add onboarding service (lazy device, vehicle groups, status)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: `/tracker/me` routes, wiring and configuration (server)

**Files:**
- Modify: `src/controllers/tracker.controller.ts`, `src/routes/tracker.route.ts`, `src/index.ts:137-139`, `.env.example`, `README.md`
- Modify (outside the repo, not committed): `/home/silke/Documents/Jotihunt 2026/.env.example`, `/home/silke/Documents/Jotihunt 2026/.env`

**Interfaces:**
- Consumes: `createTrackerOnboarding` (Task 3); `createTraccarApi` (Task 2); `traccarHttp` (Task 2); `vehicleGroupsFromEnv`, `VEHICLES`, `Vehicle` (Task 1); `verifyToken`, `validate`.
- Produces (HTTP, both auth):
  - `GET /tracker/me` → 200 `TrackerMe` (creates the Traccar device lazily).
  - `PUT /tracker/me/vehicle` body `{ vehicle: "walking" | "bike" | "car" | "motorcycle" }` → 200 `TrackerMe`; 400 `{ errors: [...] }` for another value.
  - Existing `GET /tracker/devices` / `GET /tracker/positions` unchanged.

- [ ] **Step 1: Controller** — `src/controllers/tracker.controller.ts` (full file)

```ts
import * as traccarrService from "../services/traccarr.service";
import { Request, Response } from "express";
import { logger } from "..";
import { createTraccarApi } from "../services/traccar-api";
import { traccarHttp } from "../services/traccar-http";
import { vehicleGroupsFromEnv, type Vehicle } from "../services/tracker-onboarding.helpers";
import { createTrackerOnboarding } from "../services/tracker-onboarding.service";

const onboarding = createTrackerOnboarding({
  api: traccarrService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  clientUrl: process.env.TRACCAR_CLIENT_URL,
  groups: vehicleGroupsFromEnv(),
  onError: (error) => logger.warn("Traccar onboarding: Traccar request failed", error),
});

function traccarUnavailable(res: Response) {
  return res.status(503).json({ message: "Traccar is not configured" });
}

async function getDevices(_req: Request, res: Response) {
  if (!traccarrService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const devices = await traccarrService.getDevices();
    const groups = await traccarrService.getGroups();
    devices.forEach((device) => {
      const group = groups.find((group) => group.id === device.groupId);
      device.groupName = group ? group.name : undefined;
    });
    res.json(devices);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
}

async function getPositions(_req: Request, res: Response) {
  if (!traccarrService.isTraccarConfigured) return traccarUnavailable(res);
  try {
    const positions = await traccarrService.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
}

async function getMe(req: Request, res: Response) {
  return res.status(200).json(await onboarding.getMe(req.user!));
}

async function putVehicle(req: Request, res: Response) {
  return res.status(200).json(await onboarding.setVehicle(req.user!, req.body.vehicle as Vehicle));
}

export { getDevices, getPositions, getMe, putVehicle };
```

- [ ] **Step 2: Routes** — `src/routes/tracker.route.ts` (full file)

```ts
import express from "express";
import { body } from "express-validator";
import * as trackerController from "../controllers/tracker.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { VEHICLES } from "../services/tracker-onboarding.helpers";

const router = express.Router();

router.get("/devices", verifyToken, trackerController.getDevices);
router.get("/positions", verifyToken, trackerController.getPositions);
router.get("/me", verifyToken, trackerController.getMe);
router.put(
  "/me/vehicle",
  [verifyToken, validate([body("vehicle").isIn(VEHICLES).withMessage("Voertuig moet walking, bike, car of motorcycle zijn.")])],
  trackerController.putVehicle,
);

export default router;
```

- [ ] **Step 3: Startup warning** — in `src/index.ts`, directly after the block

```ts
if (!process.env.TRACCARR_API_URL || !process.env.TRACCARR_API_TOKEN) {
  logger.warn("TRACCARR_API_URL/TRACCARR_API_TOKEN not set, tracker endpoints will return 503");
}
```

add:

```ts
if (!process.env.TRACCAR_CLIENT_URL) {
  logger.warn("TRACCAR_CLIENT_URL not set, the tracker onboarding card shows a configuration warning");
}
```

- [ ] **Step 4: Configuration files**

In the server `.env.example`, below `TRACCARR_API_TOKEN=` add:

```env
# Address the Traccar Client app sends positions to (OsmAnd port 5055), used in the onboarding QR code
TRACCAR_CLIENT_URL=
```

Root env files (not a git repo):

```bash
cd "/home/silke/Documents/Jotihunt 2026"
grep -q '^TRACCAR_CLIENT_URL=' .env.example || sed -i '/^TRACCARR_API_TOKEN=/a TRACCAR_CLIENT_URL=' .env.example
grep -q '^TRACCAR_CLIENT_URL=' .env || sed -i '/^TRACCARR_API_TOKEN=/a TRACCAR_CLIENT_URL=' .env
grep -n TRACCAR_CLIENT_URL .env.example .env
```

Expected: exactly one `TRACCAR_CLIENT_URL=` line (empty value) in each file, directly below `TRACCARR_API_TOKEN=`.

- [ ] **Step 5: README (Dutch)** — server `README.md`

a) In the `.env` example block, below `TRACCARR_API_TOKEN=token-van-traccar` add:

```env
TRACCAR_CLIENT_URL=http://tracker.jotihunt.jouwscoutinggroep.nl:5055 # Adres voor de Traccar Client-app (QR-code in "Mijn tracker")
```

b) In `### Omgevingsvariabelen`, in the ``#### `TRACCARR_API_TOKEN` `` section, replace step 1

```markdown
1. Ga naar jouw Traccar server (standaard te bereiken via `http://localhost:8082`) en log in als administrator.
```

with

```markdown
1. Ga naar jouw Traccar server (standaard te bereiken via `http://localhost:8082`) en log in als administrator. De token moet van een beheerder zijn: de server maakt hiermee de apparaten van de gebruikers aan.
```

(only the first occurrence, the one under `TRACCARR_API_TOKEN`). Then directly below that section (before ``#### `JOTIHUNT_WEB_USERNAME` en `JOTIHUNT_WEB_PASSWORD` ``) add:

```markdown
#### `TRACCAR_CLIENT_URL`
Het adres waar de Traccar Client-app op de telefoons de locaties naartoe stuurt: jouw Traccar server op poort `5055`, bijvoorbeeld `http://tracker.jotihunt.jouwscoutinggroep.nl:5055`.
Dit adres komt in de QR-code van de kaart "Mijn tracker" in de zijbalk. Is het niet ingevuld (of ontbreken `TRACCARR_API_URL`/`TRACCARR_API_TOKEN`), dan toont de kaart "Live tracking is nog niet ingesteld".
Lokaal testen met een telefoon in hetzelfde wifi-netwerk: gebruik het LAN-adres van je computer, bijvoorbeeld `http://192.168.1.10:5055`.
```

c) In `## 🛰️ GPS Tracking`, directly below the first two lines (`De GPS tracking wordt verzorgd door …` / `Om de GPS tracking werkend te krijgen, …`), add:

```markdown
**Makkelijkste manier:** iedere gebruiker ziet in de zijbalk de kaart "Mijn tracker" met een persoonlijke QR-code. Installeer de Traccar Client-app, scan de code in de app (of tik op een telefoon op "Open in Traccar-app") en zet "Continu volgen" aan. De server maakt het apparaat in Traccar zelf aan, zet het in de groep van het gekozen voertuig (Lopend / Fiets / Auto / Motor) en de kaart toont "Verbonden ✓" zodra de eerste locatie binnen is. Hiervoor moeten `TRACCAR_CLIENT_URL` en de `GROUP_*_ID`'s ingevuld zijn.

Handmatig instellen kan ook:
```

- [ ] **Step 6: Static checks**

Run: `bun_ test && bun_ run typecheck && bun_ run lint`
Expected: `0 fail`, no type or lint errors.

- [ ] **Step 7: Smoke test on the local stack** (the local `.env` has an empty `TRACCAR_CLIENT_URL` and no Traccar token)

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose up -d --build server
sleep 10
docker compose logs server --since 1m | grep -i "TRACCAR_CLIENT_URL not set"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"solver@local.test","password":"Solver123456"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s localhost:3000/tracker/me -H "Authorization: Bearer $TOKEN"; echo
curl -s -X PUT localhost:3000/tracker/me/vehicle -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"vehicle":"boat"}'; echo
curl -s -X PUT localhost:3000/tracker/me/vehicle -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"vehicle":"bike"}'; echo
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/tracker/me
```

Expected:
- log line `TRACCAR_CLIENT_URL not set, the tracker onboarding card shows a configuration warning`;
- `{"configured":false,"reason":"client_url_missing","connected":false}`;
- `{"errors":[{"type":"field","value":"boat","msg":"Voertuig moet walking, bike, car of motorcycle zijn.","path":"vehicle","location":"body"}]}`;
- `{"configured":false,"reason":"client_url_missing","connected":false}`;
- `401` without token.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tracker.controller.ts src/routes/tracker.route.ts src/index.ts .env.example README.md
git commit -m "feat(tracker): add GET /tracker/me and PUT /tracker/me/vehicle with TRACCAR_CLIENT_URL

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: Client data layer — types, helpers, QR matrix and hook (client)

**Files:**
- Modify: `package.json`, `bun.lock` (add `qrcode`, dev `@types/qrcode`)
- Create: `src/types/Tracker.ts`, `src/lib/tracker.ts`, `src/hooks/tracker.hook.ts`
- Test: `src/lib/tracker.test.ts`

**Interfaces:**
- Consumes: HTTP API from Task 4; `useAuthSWR`, `fetcherWithMethod` from `src/lib/swr.ts`.
- Produces:
  - types: `Vehicle`, `TrackerNotConfiguredReason`, `TrackerStats`, `TrackerMe` (same shapes as the server's `TrackerMe`).
  - lib: `TRACKER_POLL_NOT_CONNECTED_MS` (10 000), `TRACKER_POLL_CONNECTED_MS` (30 000), `TRACKER_POLL_NOT_CONFIGURED_MS` (60 000), `VEHICLE_OPTIONS: { value: Vehicle; label: string }[]`, `TRACCAR_PLAY_STORE_URL`, `TRACCAR_APP_STORE_URL`, `isVehicle(value: string): value is Vehicle`, `trackerRefreshInterval(status: TrackerMe | undefined): number`, `trackerSummary(status: TrackerMe | undefined): string | undefined`, `notConfiguredText(reason, admin: boolean): { title: string; hint?: string }`, `sectionTransition(previous: boolean | undefined, next: boolean | undefined): 'open' | 'close' | null`, `formatSpeed(kmh?)`, `formatBattery(percent?)`, `formatAccuracy(metres?)`, `formatDistance(metres?)`, `formatLastUpdate(iso: string | undefined, now: number)` (all `string`), `qrCodePath(text: string): { size: number; path: string }`.
  - hook: `useTrackerStatus(): { status: TrackerMe | undefined; isError: boolean; setVehicle(vehicle: Vehicle): Promise<TrackerMe> }`.

- [ ] **Step 1: Add the QR package**

Run: `bun_ add qrcode && bun_ add -d @types/qrcode`
Expected: `package.json` gains `"qrcode": "^1.5.4"` in `dependencies` and `"@types/qrcode": "^1.5.6"` in `devDependencies`; `bun.lock` updated.

- [ ] **Step 2: Types** — `src/types/Tracker.ts`

```ts
export type Vehicle = 'walking' | 'bike' | 'car' | 'motorcycle';

export type TrackerNotConfiguredReason = 'client_url_missing' | 'client_url_invalid' | 'api_missing' | 'unreachable';

export interface TrackerStats {
  /** ISO time of the last data Traccar received */
  lastUpdate?: string;
  speedKmh?: number;
  /** Battery percentage (0-100) */
  battery?: number;
  accuracyM?: number;
  distanceTodayM?: number;
}

/** Response of GET /tracker/me and PUT /tracker/me/vehicle */
export type TrackerMe =
  | { configured: false; reason: TrackerNotConfiguredReason; connected: false }
  | {
      configured: true;
      qrUrl: string;
      deepLink: string;
      uniqueId: string;
      vehicle: Vehicle;
      connected: boolean;
      stats: TrackerStats;
    };
```

- [ ] **Step 3: Write the failing test** — `src/lib/tracker.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import type { TrackerMe } from '@/types/Tracker';
import {
  formatAccuracy,
  formatBattery,
  formatDistance,
  formatLastUpdate,
  formatSpeed,
  isVehicle,
  notConfiguredText,
  qrCodePath,
  sectionTransition,
  trackerRefreshInterval,
  trackerSummary,
} from './tracker';

const configured = (connected: boolean): TrackerMe => ({
  configured: true,
  qrUrl: 'http://tracker.test:5055/?id=jh-0123456789',
  deepLink: 'org.traccar.client://?url=http%3A%2F%2Ftracker.test%3A5055%2F&id=jh-0123456789',
  uniqueId: 'jh-0123456789',
  vehicle: 'walking',
  connected,
  stats: {},
});
const notConfigured: TrackerMe = { configured: false, reason: 'client_url_missing', connected: false };

describe('trackerRefreshInterval', () => {
  test('10 s until connected, 30 s when connected, 60 s when not configured', () => {
    expect(trackerRefreshInterval(undefined)).toBe(10_000);
    expect(trackerRefreshInterval(configured(false))).toBe(10_000);
    expect(trackerRefreshInterval(configured(true))).toBe(30_000);
    expect(trackerRefreshInterval(notConfigured)).toBe(60_000);
  });
});

describe('trackerSummary', () => {
  test('per state', () => {
    expect(trackerSummary(undefined)).toBeUndefined();
    expect(trackerSummary(notConfigured)).toBe('Niet ingesteld');
    expect(trackerSummary(configured(false))).toBe('Niet verbonden');
    expect(trackerSummary(configured(true))).toBe('Verbonden ✓');
  });
});

describe('notConfiguredText', () => {
  test('admins get the fix, others only the message', () => {
    expect(notConfiguredText('client_url_missing', true)).toEqual({
      title: 'Live tracking is nog niet ingesteld.',
      hint: 'Vul TRACCAR_CLIENT_URL en de Traccar-token in .env in.',
    });
    expect(notConfiguredText('api_missing', false)).toEqual({ title: 'Live tracking is nog niet ingesteld.', hint: undefined });
    expect(notConfiguredText('client_url_invalid', true).hint).toBe('TRACCAR_CLIENT_URL in .env is geen geldige http(s)-URL.');
    expect(notConfiguredText('unreachable', false).title).toBe('De trackerserver is nu niet bereikbaar.');
  });
});

describe('sectionTransition', () => {
  test('opens on the first "not connected" and after a disconnect', () => {
    expect(sectionTransition(undefined, false)).toBe('open');
    expect(sectionTransition(true, false)).toBe('open');
  });
  test('collapses once when the phone connects', () => {
    expect(sectionTransition(false, true)).toBe('close');
  });
  test('no change otherwise (already connected on load, unchanged, not configured)', () => {
    expect(sectionTransition(undefined, true)).toBeNull();
    expect(sectionTransition(false, false)).toBeNull();
    expect(sectionTransition(true, true)).toBeNull();
    expect(sectionTransition(false, undefined)).toBeNull();
  });
});

describe('formatting', () => {
  test('speed, battery, accuracy, distance', () => {
    expect(formatSpeed(4.6)).toBe('4,6 km/u');
    expect(formatSpeed(18.5)).toBe('19 km/u');
    expect(formatSpeed(undefined)).toBe('–');
    expect(formatBattery(76)).toBe('76%');
    expect(formatBattery(undefined)).toBe('–');
    expect(formatAccuracy(6)).toBe('± 6 m');
    expect(formatAccuracy(undefined)).toBe('–');
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(4321)).toBe('4,3 km');
    expect(formatDistance(undefined)).toBe('–');
  });

  test('last update relative to now', () => {
    const now = new Date('2026-10-17T12:00:00Z').getTime();
    expect(formatLastUpdate('2026-10-17T11:59:30Z', now)).toBe('zojuist');
    expect(formatLastUpdate('2026-10-17T11:57:00Z', now)).toBe('3 min geleden');
    expect(formatLastUpdate('2026-10-17T09:30:00Z', now)).toBe('2 uur geleden');
    expect(formatLastUpdate(undefined, now)).toBe('–');
  });
});

describe('isVehicle', () => {
  test('only the four vehicles', () => {
    expect(isVehicle('bike')).toBe(true);
    expect(isVehicle('')).toBe(false);
    expect(isVehicle('boat')).toBe(false);
  });
});

describe('qrCodePath', () => {
  test('square matrix with the top-left finder pattern', () => {
    const { size, path } = qrCodePath('http://tracker.test:5055/?id=jh-0123456789&accuracy=highest');
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0);
    expect(path.startsWith('M0 0h1v1h-1z')).toBe(true);
    expect(path).toContain(`M${size - 1} 0h1v1h-1z`);
  });

  test('is deterministic', () => {
    expect(qrCodePath('abc')).toEqual(qrCodePath('abc'));
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun_ test src/lib/tracker.test.ts`
Expected: FAIL — `error: Cannot find module './tracker'`.

- [ ] **Step 5: Implement** — `src/lib/tracker.ts`

```ts
import { create } from 'qrcode';
import type { TrackerMe, TrackerNotConfiguredReason, Vehicle } from '@/types/Tracker';

export const TRACKER_POLL_NOT_CONNECTED_MS = 10_000;
export const TRACKER_POLL_CONNECTED_MS = 30_000;
/** Nothing changes quickly while live tracking isn't set up; don't poll as often. */
export const TRACKER_POLL_NOT_CONFIGURED_MS = 60_000;

export const VEHICLE_OPTIONS: { value: Vehicle; label: string }[] = [
  { value: 'walking', label: 'Lopend' },
  { value: 'bike', label: 'Fiets' },
  { value: 'car', label: 'Auto' },
  { value: 'motorcycle', label: 'Motor' },
];

export const TRACCAR_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=org.traccar.client';
export const TRACCAR_APP_STORE_URL = 'https://apps.apple.com/app/id843156974';

export function isVehicle(value: string): value is Vehicle {
  return VEHICLE_OPTIONS.some((option) => option.value === value);
}

/** SWR refresh interval: 10 s until connected, then 30 s. */
export function trackerRefreshInterval(status: TrackerMe | undefined): number {
  if (!status) return TRACKER_POLL_NOT_CONNECTED_MS;
  if (!status.configured) return TRACKER_POLL_NOT_CONFIGURED_MS;
  return status.connected ? TRACKER_POLL_CONNECTED_MS : TRACKER_POLL_NOT_CONNECTED_MS;
}

/** Collapsed-section summary. */
export function trackerSummary(status: TrackerMe | undefined): string | undefined {
  if (!status) return undefined;
  if (!status.configured) return 'Niet ingesteld';
  return status.connected ? 'Verbonden ✓' : 'Niet verbonden';
}

/** Text for the "not configured" state; admins also get the fix. */
export function notConfiguredText(reason: TrackerNotConfiguredReason, admin: boolean): { title: string; hint?: string } {
  if (reason === 'unreachable') {
    return { title: 'De trackerserver is nu niet bereikbaar.', hint: admin ? 'Controleer of Traccar draait en of de Traccar-token nog geldig is.' : undefined };
  }
  const hint =
    reason === 'client_url_invalid'
      ? 'TRACCAR_CLIENT_URL in .env is geen geldige http(s)-URL.'
      : 'Vul TRACCAR_CLIENT_URL en de Traccar-token in .env in.';
  return { title: 'Live tracking is nog niet ingesteld.', hint: admin ? hint : undefined };
}

/**
 * How the "Mijn tracker" section should react when `connected` changes (undefined = unknown / not configured):
 * open when we learn the phone is not connected, collapse once when it becomes connected.
 */
export function sectionTransition(previous: boolean | undefined, next: boolean | undefined): 'open' | 'close' | null {
  if (next === false && previous !== false) return 'open';
  if (next === true && previous === false) return 'close';
  return null;
}

const decimal = (value: number, digits: number) =>
  value.toLocaleString('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatSpeed(kmh: number | undefined): string {
  return kmh === undefined ? '–' : `${decimal(kmh, kmh < 10 ? 1 : 0)} km/u`;
}

export function formatBattery(percent: number | undefined): string {
  return percent === undefined ? '–' : `${Math.round(percent)}%`;
}

export function formatAccuracy(metres: number | undefined): string {
  return metres === undefined ? '–' : `± ${Math.round(metres)} m`;
}

export function formatDistance(metres: number | undefined): string {
  if (metres === undefined) return '–';
  return metres < 1000 ? `${Math.round(metres)} m` : `${decimal(metres / 1000, 1)} km`;
}

/** "zojuist", "3 min geleden", "2 uur geleden" or "–". */
export function formatLastUpdate(iso: string | undefined, now: number): string {
  if (!iso) return '–';
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return '–';
  if (minutes < 1) return 'zojuist';
  if (minutes < 60) return `${minutes} min geleden`;
  return `${Math.floor(minutes / 60)} uur geleden`;
}

/** QR code as one SVG path in module units (1 unit per module, no quiet zone). */
export function qrCodePath(text: string): { size: number; path: string } {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size: modules.size, path };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun_ test src/lib/tracker.test.ts`
Expected: `11 pass`, `0 fail`.

- [ ] **Step 7: Hook** — `src/hooks/tracker.hook.ts`

```ts
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod, useAuthSWR } from '@/lib/swr';
import { trackerRefreshInterval } from '@/lib/tracker';
import type { TrackerMe, Vehicle } from '@/types/Tracker';

/** The logged-in user's own tracker: QR / deep link, vehicle, connected flag and stats. */
export const useTrackerStatus = () => {
  const authHeader = useAuthHeader() || '';
  const { data, error, mutate } = useAuthSWR<TrackerMe>('/tracker/me', { refreshInterval: trackerRefreshInterval });

  /** Save the vehicle; the server answers with the new status, which goes straight into the cache. Throws on failure. */
  async function setVehicle(vehicle: Vehicle): Promise<TrackerMe> {
    const status = (await fetcherWithMethod('/tracker/me/vehicle', authHeader, 'PUT', { vehicle })) as TrackerMe;
    await mutate(status, { revalidate: false });
    return status;
  }

  return { status: data, isError: !!error, setVehicle };
};
```

(SWR 2.5 accepts a function for `refreshInterval`: it receives the latest data, so the interval switches between 10 s and 30 s by itself.)

- [ ] **Step 8: Checks**

Run: `bun_ test && bun_ run build && bun_ run lint`
Expected: `0 fail`; `vite build && tsc -b` succeeds; eslint prints nothing.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/types/Tracker.ts src/lib/tracker.ts src/lib/tracker.test.ts src/hooks/tracker.hook.ts
git commit -m "feat(tracker): add tracker types, helpers, QR matrix and status hook

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: ToggleGroup, QR code, vehicle picker and guide dialog (client)

**Files:**
- Create (shadcn CLI): `src/components/ui/toggle.tsx`, `src/components/ui/toggle-group.tsx`
- Modify: `eslint.config.js:19`
- Create: `src/components/tracker/TrackerQrCode.tsx`, `src/components/tracker/VehiclePicker.tsx`, `src/components/tracker/TrackerGuideDialog.tsx`

**Interfaces:**
- Consumes: `qrCodePath`, `VEHICLE_OPTIONS`, `isVehicle`, `TRACCAR_PLAY_STORE_URL`, `TRACCAR_APP_STORE_URL` (Task 5); `TrackerMe`, `Vehicle` (Task 5); `useIsMobile` (`src/hooks/media.hook.ts`); shadcn `Button`, `Dialog*`.
- Produces:
  - `ToggleGroup`, `ToggleGroupItem` (`@/components/ui/toggle-group`), `Toggle`, `toggleVariants` (`@/components/ui/toggle`).
  - `TrackerQrCode({ value: string; size?: number })` — default 180 px; the `<svg>` carries `data-tracker-qr`.
  - `VehiclePicker({ value: Vehicle; disabled?: boolean; onChange: (vehicle: Vehicle) => void })`.
  - `TrackerGuideDialog({ open: boolean; onOpenChange: (open: boolean) => void; status: Extract<TrackerMe, { configured: true }> })` — `DialogContent` carries `data-tracker-guide`; the live status box carries `data-tracker-live-status="connected" | "waiting"`.

- [ ] **Step 1: Add the shadcn ToggleGroup**

Run: `npx --yes shadcn@latest add toggle-group --yes`
Expected: `✔ Created 2 files: src/components/ui/toggle.tsx, src/components/ui/toggle-group.tsx`; both import `cn` from `"cn"` and the primitives from `"radix-ui"` like the other ui files (fix the imports by hand if the CLI wrote `@/lib/utils` or `@radix-ui/react-*`). No new dependency is needed (`radix-ui` is already installed). If the CLI tries to install packages and fails because `bun` is missing, run `bun_ install` afterwards.

- [ ] **Step 2: Allow the `toggleVariants` export in lint** — in `eslint.config.js` change

```js
      'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['badgeVariants', 'buttonVariants', 'useFormField'] }],
```

to

```js
      'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['badgeVariants', 'buttonVariants', 'toggleVariants', 'useFormField'] }],
```

Run: `bun_ run lint`
Expected: no output (without this change eslint reports `Fast refresh only works when a file only exports components` for `src/components/ui/toggle.tsx`).

- [ ] **Step 3: QR code** — `src/components/tracker/TrackerQrCode.tsx`

```tsx
import { useMemo } from 'react';
import { qrCodePath } from '@/lib/tracker';

const QUIET_ZONE = 2;

/**
 * QR code as inline SVG. Always black on a white tile (also in dark mode): phone cameras
 * scan dark-on-light codes most reliably.
 */
export default function TrackerQrCode({ value, size = 180 }: { value: string; size?: number }) {
  const { size: modules, path } = useMemo(() => qrCodePath(value), [value]);
  const viewBox = `${-QUIET_ZONE} ${-QUIET_ZONE} ${modules + QUIET_ZONE * 2} ${modules + QUIET_ZONE * 2}`;

  return (
    <div className="rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-border" style={{ width: size, height: size }}>
      <svg
        viewBox={viewBox}
        className="size-full"
        shapeRendering="crispEdges"
        role="img"
        aria-label="QR-code voor de Traccar Client-app"
        data-tracker-qr
      >
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Vehicle picker** — `src/components/tracker/VehiclePicker.tsx`

```tsx
import { BikeIcon, CarIcon, FootprintsIcon, MotorbikeIcon, type LucideIcon } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { isVehicle, VEHICLE_OPTIONS } from '@/lib/tracker';
import type { Vehicle } from '@/types/Tracker';

const VEHICLE_ICONS: Record<Vehicle, LucideIcon> = {
  walking: FootprintsIcon,
  bike: BikeIcon,
  car: CarIcon,
  motorcycle: MotorbikeIcon,
};

interface VehiclePickerProps {
  value: Vehicle;
  disabled?: boolean;
  onChange: (vehicle: Vehicle) => void;
}

/** Lopend / Fiets / Auto / Motor; the server moves the Traccar device to the matching group. */
export default function VehiclePicker({ value, disabled, onChange }: VehiclePickerProps) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      disabled={disabled}
      aria-label="Voertuig"
      className="w-full"
      onValueChange={(next) => {
        // Radix sends '' when the active item is clicked again: keep the current vehicle
        if (isVehicle(next) && next !== value) onChange(next);
      }}
    >
      {VEHICLE_OPTIONS.map((option) => {
        const Icon = VEHICLE_ICONS[option.value];
        return (
          <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label} className="flex-1 gap-1 px-1.5 text-xs">
            <Icon />
            {option.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
```

- [ ] **Step 5: Guide dialog** — `src/components/tracker/TrackerGuideDialog.tsx`

```tsx
import { ReactNode } from 'react';
import {
  CircleCheckIcon,
  DownloadIcon,
  LoaderCircleIcon,
  MapPinIcon,
  QrCodeIcon,
  ScanQrCodeIcon,
  SmartphoneIcon,
  ToggleRightIcon,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useIsMobile } from '@/hooks/media.hook';
import { TRACCAR_APP_STORE_URL, TRACCAR_PLAY_STORE_URL } from '@/lib/tracker';
import type { TrackerMe } from '@/types/Tracker';
import TrackerQrCode from './TrackerQrCode';

type ConfiguredTracker = Extract<TrackerMe, { configured: true }>;

function Step({ number, icon: Icon, title, children }: { number: number; icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p className="flex items-start gap-1.5 text-sm">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>{title}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

interface TrackerGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ConfiguredTracker;
}

/** Step-by-step guide for connecting the phone, with the same QR code and a live connection status. */
export default function TrackerGuideDialog({ open, onOpenChange, status }: TrackerGuideDialogProps) {
  const isMobile = useIsMobile();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" data-tracker-guide>
        <DialogHeader>
          <DialogTitle>Je telefoon koppelen</DialogTitle>
          <DialogDescription>Zo deelt je telefoon zijn locatie met het team. Dit hoef je maar één keer te doen.</DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4">
          <Step number={1} icon={DownloadIcon} title='Installeer de app "Traccar Client".'>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" className="flex-1">
                <a href={TRACCAR_PLAY_STORE_URL} target="_blank" rel="noreferrer">
                  Google Play
                </a>
              </Button>
              <Button asChild variant="outline" size="sm" className="flex-1">
                <a href={TRACCAR_APP_STORE_URL} target="_blank" rel="noreferrer">
                  App Store
                </a>
              </Button>
            </div>
          </Step>
          <Step number={2} icon={ScanQrCodeIcon} title="Open de app en tik op het QR-icoon (instellingen → QR-code scannen).">
            {isMobile && (
              <>
                <p className="text-xs text-muted-foreground">Open je deze pagina op je telefoon? Tik dan op deze knop in plaats van te scannen:</p>
                <Button asChild size="sm" className="w-full">
                  <a href={status.deepLink}>
                    <SmartphoneIcon />
                    Open in Traccar-app
                  </a>
                </Button>
              </>
            )}
          </Step>
          <Step number={3} icon={QrCodeIcon} title="Scan deze QR-code.">
            <div className="flex justify-center">
              <TrackerQrCode value={status.qrUrl} size={160} />
            </div>
          </Step>
          <Step
            number={4}
            icon={MapPinIcon}
            title='Geef locatie-toestemming "Altijd toestaan" en zet batterijbesparing voor Traccar uit.'
          />
          <Step number={5} icon={ToggleRightIcon} title='Zet de schakelaar "Continu volgen" (Service status) aan.' />
          <Step number={6} icon={CircleCheckIcon} title='Wacht tot hieronder "Verbonden ✓" verschijnt.'>
            <div
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              data-tracker-live-status={status.connected ? 'connected' : 'waiting'}
            >
              {status.connected ? (
                <>
                  <CircleCheckIcon className="size-4 text-primary" />
                  <span className="font-medium">Verbonden ✓</span>
                </>
              ) : (
                <>
                  <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">Wachten op de eerste locatie…</span>
                </>
              )}
            </div>
          </Step>
        </ol>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Checks**

Run: `bun_ test && bun_ run build && bun_ run lint`
Expected: `0 fail`; build succeeds; eslint prints nothing. (The components are not mounted yet; Task 7 does that and Task 8 checks them visually.)

- [ ] **Step 7: Commit**

```bash
git add eslint.config.js src/components/ui/toggle.tsx src/components/ui/toggle-group.tsx src/components/tracker/TrackerQrCode.tsx src/components/tracker/VehiclePicker.tsx src/components/tracker/TrackerGuideDialog.tsx
git commit -m "feat(tracker): add QR code, vehicle picker and step-by-step guide dialog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: "Mijn tracker" sidebar section (client)

**Files:**
- Modify: `src/stores/sidebar.store.ts`, `src/components/sidebar/SidebarSection.tsx`, `src/components/sidebar/SidebarSections.tsx`
- Create: `src/components/tracker/TrackerCard.tsx`, `src/components/sidebar/TrackerSection.tsx`

**Interfaces:**
- Consumes: `useTrackerStatus` (Task 5); `sectionTransition`, `trackerSummary`, `notConfiguredText`, `formatLastUpdate`, `formatSpeed`, `formatBattery`, `formatAccuracy`, `formatDistance` (Task 5); `TrackerQrCode`, `VehiclePicker`, `TrackerGuideDialog` (Task 6); `useInterval` (`src/hooks/utils/interval.hook.ts`), `useIsMobile`, `useAuthUser<User>()`.
- Produces:
  - `SidebarSectionId` gains `'tracking'` (default closed); store action `setSectionOpen(id: SidebarSectionId, open: boolean)`.
  - `SidebarSection` gains optional props `open?: boolean` and `onOpenChange?: (open: boolean) => void` (controlled mode; default behaviour unchanged).
  - `TrackerCard({ status, isError, savingVehicle, onVehicleChange, onOpenGuide })` with root `data-tracker-state="not-configured" | "pairing" | "connected"`.
  - `TrackerSection()` rendered directly above "Actieve hunters".

- [ ] **Step 1: Sidebar store** — `src/stores/sidebar.store.ts` (full file; the existing `merge` already fills in new section ids for old persisted state, so `version` stays 1)

```ts
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type SidebarSectionId = 'foxes' | 'hints' | 'predictions' | 'hintEntry' | 'counterHunt' | 'tracking' | 'hunters';
export type SheetSnap = 'peek' | 'half' | 'full';

const DEFAULT_OPEN_SECTIONS: Record<SidebarSectionId, boolean> = {
  foxes: true,
  hints: true,
  predictions: false,
  hintEntry: false,
  counterHunt: false,
  // Closed by default: the section forces itself open while the user's phone is not connected
  tracking: false,
  hunters: false,
};

interface SidebarState {
  openSections: Record<SidebarSectionId, boolean>;
  toggleSection: (id: SidebarSectionId) => void;
  /** Force a section open, e.g. when another part of the UI needs it visible. */
  openSection: (id: SidebarSectionId) => void;
  setSectionOpen: (id: SidebarSectionId, open: boolean) => void;
  sheetSnap: SheetSnap;
  setSheetSnap: (snap: SheetSnap) => void;
}

const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      openSections: DEFAULT_OPEN_SECTIONS,
      toggleSection: (id) => set((state) => ({ openSections: { ...state.openSections, [id]: !state.openSections[id] } })),
      openSection: (id) => set((state) => ({ openSections: { ...state.openSections, [id]: true } })),
      setSectionOpen: (id, open) => set((state) => ({ openSections: { ...state.openSections, [id]: open } })),
      sheetSnap: 'peek',
      setSheetSnap: (sheetSnap) => set({ sheetSnap }),
    }),
    {
      name: 'sidebar-storage',
      storage: createJSONStorage(() => localStorage),
      // Only remember which sections are open; the sheet always starts at peek
      partialize: (state) => ({ openSections: state.openSections }),
      version: 1,
      // Spread defaults under the persisted value so newly added section ids
      // (not present in older persisted state) still get their default.
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<SidebarState> | undefined;
        return {
          ...currentState,
          ...persisted,
          openSections: { ...DEFAULT_OPEN_SECTIONS, ...persisted?.openSections },
        };
      },
    },
  ),
);

export default useSidebarStore;
```

- [ ] **Step 2: Controlled mode for sections** — `src/components/sidebar/SidebarSection.tsx` (full file)

```tsx
import { ReactNode } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import useSidebarStore, { SidebarSectionId } from '@/stores/sidebar.store';
import { cn } from '@/lib/utils';

interface SidebarSectionProps {
  id: SidebarSectionId;
  title: string;
  /** Shown next to the title while the section is collapsed */
  summary?: ReactNode;
  /** Controlled open state; defaults to the persisted state in the sidebar store */
  open?: boolean;
  /** Called instead of toggling the store when the user opens/closes the section */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export default function SidebarSection({ id, title, summary, open: openProp, onOpenChange, children }: SidebarSectionProps) {
  const storedOpen = useSidebarStore((state) => state.openSections[id]);
  const toggleSection = useSidebarStore((state) => state.toggleSection);
  const open = openProp ?? storedOpen;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange ?? (() => toggleSection(id))} className="card rounded-xl bg-card px-3 py-2 text-card-foreground">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-left">
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {!open && summary && <span className="truncate">{summary}</span>}
          <ChevronDownIcon className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
```

- [ ] **Step 3: Card content** — `src/components/tracker/TrackerCard.tsx`

```tsx
import { useState } from 'react';
import { ListOrderedIcon, RefreshCwIcon, SmartphoneIcon } from 'lucide-react';
import useAuthUser from 'react-auth-kit/hooks/useAuthUser';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/media.hook';
import useInterval from '@/hooks/utils/interval.hook';
import { formatAccuracy, formatBattery, formatDistance, formatLastUpdate, formatSpeed, notConfiguredText } from '@/lib/tracker';
import type { TrackerMe, Vehicle } from '@/types/Tracker';
import type { User } from '@/types/User';
import TrackerQrCode from './TrackerQrCode';
import VehiclePicker from './VehiclePicker';

const CLOCK_TICK_MS = 30_000;

interface TrackerCardProps {
  status: TrackerMe | undefined;
  isError: boolean;
  savingVehicle: boolean;
  onVehicleChange: (vehicle: Vehicle) => void;
  onOpenGuide: () => void;
}

/** Content of the "Mijn tracker" section: not configured / QR to connect / stats when connected. */
export default function TrackerCard({ status, isError, savingVehicle, onVehicleChange, onOpenGuide }: TrackerCardProps) {
  const auth = useAuthUser<User>();
  const isMobile = useIsMobile();
  const [relink, setRelink] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), CLOCK_TICK_MS);

  if (!status) {
    if (isError) return <p className="text-xs text-muted-foreground">Trackerstatus kan niet worden geladen.</p>;
    return <Skeleton className="h-52 rounded-md" />;
  }

  if (!status.configured) {
    const text = notConfiguredText(status.reason, !!auth?.admin);
    return (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-tracker-state="not-configured">
        <p>{text.title}</p>
        {text.hint && <p>{text.hint}</p>}
      </div>
    );
  }

  const vehiclePicker = <VehiclePicker value={status.vehicle} disabled={savingVehicle} onChange={onVehicleChange} />;

  if (status.connected && !relink) {
    const { stats } = status;
    const rows: [string, string][] = [
      ['Laatste update', formatLastUpdate(stats.lastUpdate, now)],
      ['Snelheid', formatSpeed(stats.speedKmh)],
      ['Batterij', formatBattery(stats.battery)],
      ['Nauwkeurigheid', formatAccuracy(stats.accuracyM)],
      ['Afstand vandaag', formatDistance(stats.distanceTodayM)],
    ];
    return (
      <div className="flex flex-col gap-2" data-tracker-state="connected">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {vehiclePicker}
        <Button variant="outline" size="sm" onClick={() => setRelink(true)}>
          <RefreshCwIcon />
          Opnieuw koppelen
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2" data-tracker-state="pairing">
      <TrackerQrCode value={status.qrUrl} />
      <p className="text-center text-xs text-muted-foreground">Scan deze code met de Traccar Client-app</p>
      {vehiclePicker}
      {isMobile && (
        <Button asChild size="sm" className="w-full">
          <a href={status.deepLink}>
            <SmartphoneIcon />
            Open in Traccar-app
          </a>
        </Button>
      )}
      <div className="flex w-full gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={onOpenGuide}>
          <ListOrderedIcon />
          Uitleg stap voor stap
        </Button>
        {status.connected && (
          <Button variant="ghost" size="sm" onClick={() => setRelink(false)}>
            Klaar
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Section with auto open / collapse once** — `src/components/sidebar/TrackerSection.tsx`

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import TrackerCard from '@/components/tracker/TrackerCard';
import TrackerGuideDialog from '@/components/tracker/TrackerGuideDialog';
import { useTrackerStatus } from '@/hooks/tracker.hook';
import { sectionTransition, trackerSummary } from '@/lib/tracker';
import useSidebarStore from '@/stores/sidebar.store';
import type { Vehicle } from '@/types/Tracker';
import SidebarSection from './SidebarSection';

/**
 * "Mijn tracker": connect this user's phone as GPS tracker. Forced open while the phone is not connected,
 * collapsed once when it connects; after that the user decides (persisted like the other sections).
 */
export default function TrackerSection() {
  const { status, isError, setVehicle } = useTrackerStatus();
  const storedOpen = useSidebarStore((state) => state.openSections.tracking);
  const setSectionOpen = useSidebarStore((state) => state.setSectionOpen);
  const [guideOpen, setGuideOpen] = useState(false);
  const [savingVehicle, setSavingVehicle] = useState(false);

  // Adjust the open state during render when `connected` changes (no effect, no ref)
  const connected = status?.configured ? status.connected : undefined;
  const [prevConnected, setPrevConnected] = useState<boolean | undefined>(undefined);
  const [forcedOpen, setForcedOpen] = useState<boolean | null>(null);
  if (connected !== prevConnected) {
    setPrevConnected(connected);
    const transition = sectionTransition(prevConnected, connected);
    if (transition) setForcedOpen(transition === 'open');
  }

  function handleOpenChange(open: boolean) {
    setForcedOpen(null);
    setSectionOpen('tracking', open);
  }

  async function changeVehicle(vehicle: Vehicle) {
    setSavingVehicle(true);
    try {
      await setVehicle(vehicle);
    } catch {
      toast.error('Voertuig opslaan is mislukt', { description: 'Probeer het opnieuw.' });
    } finally {
      setSavingVehicle(false);
    }
  }

  const summaryText = trackerSummary(status);
  const summary = connected ? <Badge variant="secondary">{summaryText}</Badge> : summaryText;

  return (
    <>
      <SidebarSection id="tracking" title="Mijn tracker" summary={summary} open={forcedOpen ?? storedOpen} onOpenChange={handleOpenChange}>
        <TrackerCard
          status={status}
          isError={isError}
          savingVehicle={savingVehicle}
          onVehicleChange={changeVehicle}
          onOpenGuide={() => setGuideOpen(true)}
        />
      </SidebarSection>
      {status?.configured && <TrackerGuideDialog open={guideOpen} onOpenChange={setGuideOpen} status={status} />}
    </>
  );
}
```

- [ ] **Step 5: Mount it above "Actieve hunters"** — in `src/components/sidebar/SidebarSections.tsx` add below `import PredictionList from './PredictionList';`:

```tsx
import TrackerSection from './TrackerSection';
```

and directly before `<SidebarSection id="hunters" title="Actieve hunters" …>` (after the `counterHunt` block) add:

```tsx
      <TrackerSection />
```

- [ ] **Step 6: Checks**

Run: `bun_ test && bun_ run build && bun_ run lint`
Expected: `0 fail`; build succeeds; eslint prints nothing (in particular no `react-hooks` errors for the render-time `setPrevConnected` / `setForcedOpen` in `TrackerSection`).

- [ ] **Step 7: Commit**

```bash
git add src/stores/sidebar.store.ts src/components/sidebar/SidebarSection.tsx src/components/sidebar/SidebarSections.tsx src/components/tracker/TrackerCard.tsx src/components/sidebar/TrackerSection.tsx
git commit -m "feat(tracker): add Mijn tracker sidebar section with auto open and collapse

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: End-to-end verification on the local stack (server + client)

The local Traccar has no API token and one cannot be created unattended, so this task (a) checks the not-configured card on the normal stack and (b) points the server at a tiny fake Traccar (in-memory Bun script on the `jotihunt_default` network, also published on host port 18082) to check "not connected" and "connected". Fix bugs found here in the relevant task's files and commit them as `fix(tracker): …` (with the trailer) in the repo they belong to.

**Files:**
- Create (outside the repos, not committed): `/tmp/fake-traccar/fake-traccar.ts`, `/tmp/tracker-e2e.override.yml`, `/tmp/shot/tracker.ts`

**Interfaces:**
- Consumes: everything above; selectors `data-tracker-state`, `data-tracker-qr`, `data-tracker-guide`, `data-tracker-live-status`, `a[href^="org.traccar.client://"]`, `button[aria-label="Fiets"]`.
- Produces: screenshots in `/tmp/shot/`: `tracker-unconfigured.png`, `tracker-mobile.png`, `tracker-pairing.png`, `tracker-guide.png`, `tracker-guide-connected.png`, `tracker-collapsed.png`, `tracker-connected.png`.

- [ ] **Step 1: Rebuild the normal stack from both branches**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose up -d --build server client
sleep 10
docker compose logs server --since 1m | grep -i "TRACCAR_CLIENT_URL not set"
```

Expected: `TRACCAR_CLIENT_URL not set, the tracker onboarding card shows a configuration warning`.

- [ ] **Step 2: Screenshot script** — `/tmp/shot/tracker.ts`

```ts
import puppeteer, { type Page } from "puppeteer";

// MODE=unconfigured: screenshot of the "not configured" card (normal local stack).
// MODE=configured: server points at the fake Traccar (http://localhost:18082 from this container).
const mode = process.env.MODE ?? "configured";
const API = "http://localhost:3000";
const FAKE = "http://localhost:18082";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const errors: string[] = [];

async function login(page: Page) {
  await page.goto("http://localhost:8080/login", { waitUntil: "networkidle2" });
  const inputs = await page.$$("input");
  await inputs[0].type("solver@local.test");
  await inputs[1].type("Solver123456");
  await page.click("button[type=submit]");
  await wait(4000);
  // Only "Mijn tracker" and "Actieve hunters" open; drop the persisted tracking state so the defaults apply
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("sidebar-storage") || '{"state":{},"version":1}');
    stored.state.openSections = { foxes: false, hints: false, predictions: false, hintEntry: false, counterHunt: false, hunters: true };
    localStorage.setItem("sidebar-storage", JSON.stringify(stored));
  });
  await page.goto("http://localhost:8080/", { waitUntil: "networkidle2" });
  await wait(5000);
  await page.evaluate(() => document.querySelectorAll("[data-sonner-toaster]").forEach((toaster) => ((toaster as HTMLElement).style.display = "none")));
}

const trackerState = (page: Page) => page.$eval("[data-tracker-state]", (element) => element.getAttribute("data-tracker-state")).catch(() => "absent");

async function uniqueIdFromApi() {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "solver@local.test", password: "Solver123456" }),
  }).then((response) => response.json());
  const me = await fetch(`${API}/tracker/me`, { headers: { Authorization: `Bearer ${login.accessToken}` } }).then((response) => response.json());
  console.log("tracker/me:", JSON.stringify(me));
  return me.uniqueId as string;
}

if (mode === "unconfigured") {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 800 });
  await login(page);
  // Not configured: the section stays closed by default; open it
  await page.evaluate(() => {
    const trigger = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Mijn tracker"));
    trigger?.click();
  });
  await wait(800);
  console.log("state:", await trackerState(page));
  await page.screenshot({ path: "/out/tracker-unconfigured.png" });
} else {
  const uniqueId = await uniqueIdFromApi();
  await fetch(`${FAKE}/fake/stale?uniqueId=${uniqueId}`, { method: "POST" });

  // Mobile, not connected: sheet dragged up to full
  const mobile = await browser.newPage();
  mobile.on("pageerror", (error) => errors.push(String(error)));
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await login(mobile);
  const handle = await mobile.$("[data-vaul-handle]");
  const box = await handle?.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await mobile.touchscreen.touchStart(x, y);
    for (let step = 1; step <= 20; step++) {
      await mobile.touchscreen.touchMove(x, y - step * 35);
      await wait(20);
    }
    await mobile.touchscreen.touchEnd();
    await wait(1500);
  }
  await mobile.evaluate(() => document.querySelector("[data-tracker-qr]")?.scrollIntoView({ block: "center" }));
  await wait(500);
  console.log("mobile state:", await trackerState(mobile), "deep link:", await mobile.$eval('a[href^="org.traccar.client://"]', (a) => a.getAttribute("href")).catch(() => "none"));
  await mobile.screenshot({ path: "/out/tracker-mobile.png" });
  await mobile.close();

  // Desktop, not connected → guide → phone reports → collapses → reopen shows stats
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 800 });
  await login(page);
  console.log("desktop state:", await trackerState(page));
  await page.screenshot({ path: "/out/tracker-pairing.png" });

  const vehicle = await page.$('[role="radio"][aria-label="Fiets"], button[aria-label="Fiets"]');
  await vehicle?.click();
  await wait(1500);
  const devices = await fetch(`${FAKE}/fake/devices`).then((response) => response.json());
  console.log("groupId after Fiets:", devices.find((device: { uniqueId: string }) => device.uniqueId === uniqueId)?.groupId);

  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Uitleg stap voor stap"))?.click());
  await wait(1000);
  await page.screenshot({ path: "/out/tracker-guide.png" });

  await fetch(`${FAKE}/fake/report?uniqueId=${uniqueId}`, { method: "POST" });
  await wait(12_000);
  console.log("guide live status:", await page.$eval("[data-tracker-live-status]", (element) => element.getAttribute("data-tracker-live-status")).catch(() => "absent"));
  await page.screenshot({ path: "/out/tracker-guide-connected.png" });
  await page.keyboard.press("Escape");
  await wait(800);
  console.log("after connect (collapsed → absent):", await trackerState(page));
  await page.screenshot({ path: "/out/tracker-collapsed.png" });

  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Mijn tracker"))?.click());
  await wait(800);
  console.log("reopened state:", await trackerState(page));
  await page.screenshot({ path: "/out/tracker-connected.png" });
}

console.log("errors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();
```

- [ ] **Step 3: Not configured**

```bash
docker run --rm --network host -e MODE=unconfigured -v /tmp/shot:/out -w /usr/src/app --entrypoint bun jotihunt-server /out/tracker.ts
```

Expected: `state: not-configured`, `errors: []`.

- [ ] **Step 4: Fake Traccar** — `/tmp/fake-traccar/fake-traccar.ts`

```ts
// Tiny in-memory stand-in for the Traccar REST API, only for the local E2E check of the onboarding card.
// Control endpoints: POST /fake/report?uniqueId=… (simulate a phone sending a position now),
//                    POST /fake/stale?uniqueId=… (last update 10 minutes ago), GET /fake/devices.
interface Device {
  id: number;
  name: string;
  uniqueId: string;
  groupId: number;
  positionId: number | null;
  lastUpdate: string | null;
  status: string;
  disabled: boolean;
  attributes: Record<string, unknown>;
  [key: string]: unknown;
}

const devices = new Map<number, Device>();
const positions = new Map<number, Record<string, unknown>>();
let nextDeviceId = 1;
let nextPositionId = 1;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const byUniqueId = (uniqueId: string | null) => [...devices.values()].find((device) => device.uniqueId === uniqueId);

Bun.serve({
  port: 8082,
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    console.log(request.method, pathname + url.search);
    if (!pathname.startsWith("/fake/") && request.headers.get("authorization") !== "Bearer fake-token") {
      return json({ message: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && pathname === "/api/devices") {
      const uniqueId = searchParams.get("uniqueId");
      return json(uniqueId ? [...devices.values()].filter((device) => device.uniqueId === uniqueId) : [...devices.values()]);
    }
    if (request.method === "POST" && pathname === "/api/devices") {
      const body = (await request.json()) as Partial<Device>;
      const device: Device = {
        id: nextDeviceId++,
        name: String(body.name),
        uniqueId: String(body.uniqueId),
        groupId: Number(body.groupId ?? 0),
        positionId: null,
        lastUpdate: null,
        status: "unknown",
        disabled: false,
        attributes: {},
      };
      devices.set(device.id, device);
      return json(device);
    }
    const put = pathname.match(/^\/api\/devices\/(\d+)$/);
    if (request.method === "PUT" && put) {
      const id = Number(put[1]);
      if (!devices.has(id)) return json({ message: "Not found" }, 404);
      const device = { ...(await request.json()), id } as Device;
      devices.set(id, device);
      return json(device);
    }
    if (request.method === "GET" && pathname === "/api/positions") {
      const id = searchParams.get("id");
      if (id) return json(positions.has(Number(id)) ? [positions.get(Number(id))] : []);
      return json([...devices.values()].filter((device) => device.positionId).map((device) => positions.get(device.positionId!)));
    }
    if (request.method === "GET" && pathname === "/api/groups") return json([]);
    if (request.method === "GET" && pathname === "/api/reports/summary") {
      const deviceId = Number(searchParams.get("deviceId"));
      return json(devices.get(deviceId)?.positionId ? [{ deviceId, distance: 4321 }] : []);
    }

    if (request.method === "POST" && (pathname === "/fake/report" || pathname === "/fake/stale")) {
      const device = byUniqueId(searchParams.get("uniqueId"));
      if (!device) return json({ message: "Unknown uniqueId" }, 404);
      const time = new Date(Date.now() - (pathname === "/fake/stale" ? 10 * 60_000 : 0)).toISOString();
      const position = {
        id: nextPositionId++,
        deviceId: device.id,
        latitude: 52.2,
        longitude: 5.9,
        speed: 2.5,
        course: 90,
        accuracy: 6,
        fixTime: time,
        deviceTime: time,
        serverTime: time,
        attributes: { batteryLevel: 76 },
      };
      positions.set(position.id, position);
      devices.set(device.id, { ...device, positionId: position.id, lastUpdate: time, status: "online" });
      return json(devices.get(device.id));
    }
    if (request.method === "GET" && pathname === "/fake/devices") return json([...devices.values()]);
    return json({ message: "Not found" }, 404);
  },
});
console.log("fake Traccar listening on :8082");
```

Start it and point the server at it (temporary env overrides; `environment` wins over `env_file`):

```bash
docker run --rm -d --name fake-traccar --network jotihunt_default -p 18082:8082 \
  -v /tmp/fake-traccar:/app:ro -w /app oven/bun:1 bun fake-traccar.ts
cat > /tmp/tracker-e2e.override.yml <<'EOF'
services:
  server:
    environment:
      TRACCARR_API_URL: http://fake-traccar:8082
      TRACCARR_API_TOKEN: fake-token
      TRACCAR_CLIENT_URL: http://192.168.1.10:5055
      GROUP_WALKING_ID: "3"
      GROUP_BIKE_ID: "5"
EOF
cd "/home/silke/Documents/Jotihunt 2026"
docker compose -f docker-compose.yml -f /tmp/tracker-e2e.override.yml up -d server
sleep 10
curl -s -o /dev/null -w "%{http_code}\n" localhost:18082/api/devices
docker compose logs server --since 30s | grep -c "TRACCAR_CLIENT_URL not set"
```

Expected: `401` (the stub requires the fake token); `0` (the warning is gone).

- [ ] **Step 5: Not connected → connected**

```bash
docker run --rm --network host -e MODE=configured -v /tmp/shot:/out -w /usr/src/app --entrypoint bun jotihunt-server /out/tracker.ts
```

Expected output (the uniqueId differs):
- `tracker/me: {"configured":true,"qrUrl":"http://192.168.1.10:5055/?id=jh-…&accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true","deepLink":"org.traccar.client://?url=http%3A%2F%2F192.168.1.10%3A5055%2F&id=jh-…",…,"vehicle":"walking","connected":false,"stats":{}}`
- `mobile state: pairing deep link: org.traccar.client://?url=http%3A%2F%2F192.168.1.10%3A5055%2F&id=jh-…`
- `desktop state: pairing`
- `groupId after Fiets: 5`
- `guide live status: connected`
- `after connect (collapsed → absent): absent`
- `reopened state: connected`
- `errors: []`

- [ ] **Step 6: Review the screenshots** (open each PNG with the Read tool) and check:
  - `tracker-unconfigured.png`: "Mijn tracker" directly above "Actieve hunters", muted text `Live tracking is nog niet ingesteld.` (solver is no admin, so no `.env` hint);
  - `tracker-pairing.png`: section forced open without user action; black-on-white QR (~180 px), `Scan deze code met de Traccar Client-app`, the four vehicle buttons with icons on one row (`Lopend` active), `Uitleg stap voor stap`; no deep-link button on desktop;
  - `tracker-mobile.png`: same card in the bottom sheet with the full-width `Open in Traccar-app` button;
  - `tracker-guide.png`: dialog `Je telefoon koppelen` with the 6 numbered steps, `Google Play` / `App Store` buttons side by side, the same QR and `Wachten op de eerste locatie…`; `Fiets` now active in the card behind it;
  - `tracker-guide-connected.png`: live status `Verbonden ✓`;
  - `tracker-collapsed.png`: section collapsed with the `Verbonden ✓` badge; "Actieve hunters" lists the fake device;
  - `tracker-connected.png`: stats `Laatste update zojuist`, `Snelheid 4,6 km/u`, `Batterij 76%`, `Nauwkeurigheid ± 6 m`, `Afstand vandaag 4,3 km`, vehicle picker and `Opnieuw koppelen`.
  - Optional manual check in a browser at http://localhost:8080 while the fake is still running: dark mode (Settings) keeps the QR on white; `Opnieuw koppelen` shows the QR again with `Klaar`.

- [ ] **Step 7: Restore the normal stack**

```bash
docker stop fake-traccar
cd "/home/silke/Documents/Jotihunt 2026"
docker compose exec -T mongodb mongosh jotihunt --quiet --eval \
  'printjson(db.users.updateOne({email: "solver@local.test"}, {$unset: {tracker: 1}}).modifiedCount)'
docker compose up -d server
sleep 10
docker compose logs server --since 30s | grep -i "TRACCAR_CLIENT_URL not set"
rm /tmp/tracker-e2e.override.yml
```

Expected: `1` (the solver's fake device reference removed); the `TRACCAR_CLIENT_URL not set …` warning is back (normal env restored).

- [ ] **Step 8: Final checks in both repos** — server: `bun_ test`, `bun_ run typecheck`, `bun_ run lint`; client: `bun_ test`, `bun_ run build`, `bun_ run lint` → all clean; `git status` clean in both repos.

- [ ] **Step 9 (manual, with a real phone — not part of the automated run):** set `TRACCAR_CLIENT_URL=http://<LAN-IP>:5055` in the root `.env`, create an admin API token in the Traccar web UI (http://localhost:8082 → Instellingen → Voorkeuren → Token) and put it in `TRACCARR_API_TOKEN`, `docker compose up -d server`, then scan the QR with the Traccar Client app — or simulate a phone with `curl "http://localhost:5055/?id=<uniqueId>&lat=52.2&lon=5.9&timestamp=$(date +%s)"` — and confirm the card turns `Verbonden ✓`.
