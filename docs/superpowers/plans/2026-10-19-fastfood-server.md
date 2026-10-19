# Fastfood layers — server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every McDonald's, KFC and Burger King in the Netherlands (from OpenStreetMap) with their open intervals for the next 8 days at `GET /fastfood`.

**Architecture:** A small Overpass client fetches all three brands for NL; a `FastfoodService` (like `BuildingsService`/`Life360Service`) stores them in the REAL database (demo state store's connection), refreshes daily from its own timer, and answers `list(now)` with intervals computed by the `opening_hours` library (cached 10 min). A logged-in route exposes the list.

**Tech Stack:** Bun, Express 5, Mongoose 9, `opening_hours` 3.15, bun:test.

Spec: `jotihunt-tracker-client/docs/superpowers/specs/2026-10-19-fastfood-layers-design.md`.

## Global Constraints

- The server runs with `TZ=Europe/Amsterdam` (Dockerfile). `opening_hours` evaluates in the process's local time zone, so every test file that touches intervals sets `process.env.TZ = "Europe/Amsterdam"` on its first line.
- Brands by `brand:wikidata`: McDonald's `Q38076`, KFC `Q524757`, Burger King `Q177054`. Brand ids on the wire: `"mcdonalds" | "kfc" | "burgerking"`.
- Overpass primary `https://overpass-api.de/api/interpreter`, fallback `https://overpass.kumi.systems/api/interpreter`; User-Agent `jotihunt-tracker (fastfood layer)`; 120 s timeout.
- A refresh with fewer than 100 restaurants counts as a failure; the old data stays.
- Refresh daily (when the newest `updatedAt` is older than 24 h), checked at start and every hour.
- `GET /fastfood`: `verifyToken`, `Cache-Control: private, max-age=300`, JSON array.
- Interval window: 8 days from `now`; intervals with the library's "unknown" flag are dropped; if all of them were unknown, the hours count as unknown (`intervals` absent).
- Commands: tests `npx --yes bun test <file>`, types `npx --yes bun x tsc --noEmit`, lint `npx --yes bun x eslint <files>`. Mongo runs in docker on localhost:27017 (test DB `jotihunt-test`).
- Never restart the docker stack; work in a worktree (`.worktrees/server-fastfood`, branch `feat/fastfood`).

---

### Task 1: Pure helpers — brand, mapping, open intervals

**Files:**
- Modify: `package.json` (add `opening_hours`)
- Create: `src/services/fastfood.helpers.ts`
- Test: `src/services/fastfood.helpers.test.ts`

**Interfaces:**
- Produces:
  - `type Brand = "mcdonalds" | "kfc" | "burgerking"`
  - `interface OverpassElement { type: "node" | "way" | "relation"; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }`
  - `interface Restaurant { osmId: string; brand: Brand; branch?: string; location: { type: "Point"; coordinates: [number, number] }; street?: string; houseNumber?: string; postcode?: string; city?: string; phone?: string; website?: string; driveThrough?: boolean; openingHours?: string; updatedAt: Date }`
  - `interface OpenInterval { start: Date; end: Date }`
  - `brandOf(tags: Record<string, string>): Brand | undefined`
  - `toRestaurant(element: OverpassElement, now: Date): Restaurant | undefined`
  - `openIntervals(openingHours: string | undefined, from: Date, days?: number): OpenInterval[] | undefined`
  - `OVERPASS_QUERY: string`

- [ ] **Step 1: Add the dependency**

```bash
cd "/home/silke/Documents/Jotihunt 2026/.worktrees/server-fastfood"
npx --yes bun add opening_hours@3.15.0
```

Expected: `package.json` has `"opening_hours": "3.15.0"` (or `^3.15.0`) under dependencies, `bun.lock` updated.

- [ ] **Step 2: Write the failing tests**

`src/services/fastfood.helpers.test.ts`:

```ts
process.env.TZ = "Europe/Amsterdam";
import { describe, expect, test } from "bun:test";
import { brandOf, openIntervals, toRestaurant, type OverpassElement } from "./fastfood.helpers";

const NOW = new Date("2026-10-19T12:00:00+02:00");

// Real elements from Overpass (2026-10-19), trimmed
const ARNHEM: OverpassElement = {
  type: "node",
  id: 1234,
  lat: 51.9818,
  lon: 5.9089,
  tags: {
    "addr:city": "Arnhem",
    "addr:housenumber": "36",
    "addr:postcode": "6811EW",
    "addr:street": "Rijnstraat",
    amenity: "fast_food",
    brand: "McDonald's",
    "brand:wikidata": "Q38076",
    "contact:website": "https://mcdonaldsrestaurant.nl/arnhem-rijnstraat",
    description: "McDonald's Arnhem Rijnstraat",
    drive_through: "no",
    name: "McDonald's",
    opening_hours: "Mo-We 08:30-22:00; Th 08:30-23:00; Fr,Sa 08:30-01:30; Su 09:00-22:00",
    phone: "+31 26 445 6234",
  },
};
const VEENENDAAL_WAY: OverpassElement = {
  type: "way",
  id: 99,
  center: { lat: 52.03, lon: 5.54 },
  tags: { "brand:wikidata": "Q177054", brand: "Burger King", description: "Burger King Veenendaal Rondweg West", "addr:city": "Veenendaal" },
};

describe("brandOf", () => {
  test("maps the three wikidata ids", () => {
    expect(brandOf({ "brand:wikidata": "Q38076" })).toBe("mcdonalds");
    expect(brandOf({ "brand:wikidata": "Q524757" })).toBe("kfc");
    expect(brandOf({ "brand:wikidata": "Q177054" })).toBe("burgerking");
  });
  test("anything else is undefined", () => {
    expect(brandOf({ "brand:wikidata": "Q1" })).toBeUndefined();
    expect(brandOf({})).toBeUndefined();
  });
});

describe("toRestaurant", () => {
  test("maps a node with all fields", () => {
    expect(toRestaurant(ARNHEM, NOW)).toEqual({
      osmId: "node/1234",
      brand: "mcdonalds",
      branch: "Arnhem Rijnstraat",
      location: { type: "Point", coordinates: [5.9089, 51.9818] },
      street: "Rijnstraat",
      houseNumber: "36",
      postcode: "6811EW",
      city: "Arnhem",
      phone: "+31 26 445 6234",
      website: "https://mcdonaldsrestaurant.nl/arnhem-rijnstraat",
      driveThrough: false,
      openingHours: "Mo-We 08:30-22:00; Th 08:30-23:00; Fr,Sa 08:30-01:30; Su 09:00-22:00",
      updatedAt: NOW,
    });
  });
  test("a way uses its center and leaves missing fields out", () => {
    const restaurant = toRestaurant(VEENENDAAL_WAY, NOW)!;
    expect(restaurant.osmId).toBe("way/99");
    expect(restaurant.location.coordinates).toEqual([5.54, 52.03]);
    expect(restaurant.branch).toBe("Veenendaal Rondweg West");
    expect(restaurant).not.toHaveProperty("phone");
    expect(restaurant).not.toHaveProperty("driveThrough");
    expect(restaurant).not.toHaveProperty("openingHours");
  });
  test("phone and website fall back to contact:* and url", () => {
    const element: OverpassElement = { ...ARNHEM, tags: { "brand:wikidata": "Q524757", "contact:phone": "+31 1", url: "http://kfc.nl/x" } };
    const restaurant = toRestaurant(element, NOW)!;
    expect(restaurant.phone).toBe("+31 1");
    expect(restaurant.website).toBe("http://kfc.nl/x");
  });
  test("branch tag wins over description; a description equal to the brand gives no branch", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, branch: "Centrum" } }, NOW)!.branch).toBe("Centrum");
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, description: "McDonald's" } }, NOW)!.branch).toBeUndefined();
  });
  test("a description longer than 60 characters is not a branch", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, description: "x".repeat(61) } }, NOW)!.branch).toBeUndefined();
  });
  test("drive_through yes is true", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, drive_through: "yes" } }, NOW)!.driveThrough).toBe(true);
  });
  test("unknown brand or no coordinates is undefined", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { "brand:wikidata": "Q1" } }, NOW)).toBeUndefined();
    expect(toRestaurant({ type: "node", id: 1, tags: ARNHEM.tags }, NOW)).toBeUndefined();
  });
});

const iso = (intervals: { start: Date; end: Date }[] | undefined) => intervals?.map(({ start, end }) => [start.toISOString(), end.toISOString()]);
const SATURDAY = new Date("2026-10-17T00:00:00+02:00");

describe("openIntervals", () => {
  test("an interval past midnight is one interval", () => {
    expect(iso(openIntervals("Mo-Su 10:00-01:00", SATURDAY, 2))).toEqual([
      ["2026-10-16T22:00:00.000Z", "2026-10-16T23:00:00.000Z"],
      ["2026-10-17T08:00:00.000Z", "2026-10-17T23:00:00.000Z"],
      ["2026-10-18T08:00:00.000Z", "2026-10-18T22:00:00.000Z"],
    ]);
  });
  test("24/7 is one interval over the whole window", () => {
    expect(iso(openIntervals("24/7", SATURDAY, 8))).toEqual([["2026-10-16T22:00:00.000Z", "2026-10-24T22:00:00.000Z"]]);
  });
  test("closed all window is an empty list", () => {
    expect(openIntervals("off", SATURDAY, 8)).toEqual([]);
    expect(openIntervals("Mo-Fr 10:00-22:00", SATURDAY, 2)).toEqual([]);
  });
  test("follows the end of summer time", () => {
    expect(iso(openIntervals("Mo-Su 10:00-22:00", new Date("2026-10-24T00:00:00+02:00"), 2))).toEqual([
      ["2026-10-24T08:00:00.000Z", "2026-10-24T20:00:00.000Z"],
      ["2026-10-25T09:00:00.000Z", "2026-10-25T21:00:00.000Z"],
    ]);
  });
  test("missing, invalid or only unknown hours are undefined", () => {
    expect(openIntervals(undefined, SATURDAY)).toBeUndefined();
    expect(openIntervals("blah", SATURDAY)).toBeUndefined();
    expect(openIntervals("Mo-Su 10:00-22:00 unknown", SATURDAY, 2)).toBeUndefined();
  });
  test("comments don't matter", () => {
    expect(openIntervals('Mo-Su 07:00-23:00 open "drive"', SATURDAY, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx --yes bun test src/services/fastfood.helpers.test.ts`
Expected: FAIL, `Cannot find module './fastfood.helpers'`.

- [ ] **Step 4: Implement**

`src/services/fastfood.helpers.ts`:

```ts
import OpeningHours from "opening_hours";

/** The chains on the map, by their Wikidata id in OSM's `brand:wikidata` tag. */
export type Brand = "mcdonalds" | "kfc" | "burgerking";
const BRAND_WIKIDATA: Record<string, Brand> = { Q38076: "mcdonalds", Q524757: "kfc", Q177054: "burgerking" };
/** Brand names a `description` starts with ("McDonald's Arnhem Rijnstraat"), stripped to get the branch. */
const BRAND_NAMES: Record<Brand, string[]> = {
  mcdonalds: ["McDonald's", "McDonalds"],
  kfc: ["Kentucky Fried Chicken", "KFC"],
  burgerking: ["Burger King"],
};
const MAX_BRANCH_LENGTH = 60;

/** All three chains in the Netherlands; ways and relations come with a centre point. */
export const OVERPASS_QUERY = `[out:json][timeout:90];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
nwr["brand:wikidata"~"^(Q38076|Q524757|Q177054)$"](area.nl);
out center tags;`;

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface Restaurant {
  /** "node/123" */
  osmId: string;
  brand: Brand;
  /** e.g. "Arnhem Rijnstraat" */
  branch?: string;
  location: { type: "Point"; coordinates: [number, number] };
  street?: string;
  houseNumber?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  website?: string;
  driveThrough?: boolean;
  /** The raw OSM `opening_hours` value */
  openingHours?: string;
  updatedAt: Date;
}

export interface OpenInterval {
  start: Date;
  end: Date;
}

export function brandOf(tags: Record<string, string>): Brand | undefined {
  return BRAND_WIKIDATA[tags["brand:wikidata"] ?? ""];
}

function branchOf(tags: Record<string, string>, brand: Brand): string | undefined {
  if (tags.branch?.trim()) return tags.branch.trim();
  let text = tags.description?.trim() ?? "";
  const prefix = BRAND_NAMES[brand].find((name) => text.toLowerCase().startsWith(name.toLowerCase()));
  if (prefix) text = text.slice(prefix.length).trim();
  return text && text.length <= MAX_BRANCH_LENGTH ? text : undefined;
}

function driveThroughOf(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** Drop undefined fields, so the stored documents and the API items only carry what OSM knows. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** One Overpass element as a restaurant; undefined for another brand or an element without a position. */
export function toRestaurant(element: OverpassElement, now: Date): Restaurant | undefined {
  const tags = element.tags ?? {};
  const brand = brandOf(tags);
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!brand || lat === undefined || lon === undefined) return undefined;
  return compact({
    osmId: `${element.type}/${element.id}`,
    brand,
    branch: branchOf(tags, brand),
    location: { type: "Point" as const, coordinates: [lon, lat] as [number, number] },
    street: tags["addr:street"],
    houseNumber: tags["addr:housenumber"],
    postcode: tags["addr:postcode"],
    city: tags["addr:city"],
    phone: tags.phone ?? tags["contact:phone"],
    website: tags.website ?? tags["contact:website"] ?? tags.url,
    driveThrough: driveThroughOf(tags.drive_through),
    openingHours: tags.opening_hours?.trim() || undefined,
    updatedAt: now,
  });
}

/** Public holidays (PH) and school holidays (SH) are Dutch ones */
const NOMINATIM = { lat: 52.1, lon: 5.3, address: { country_code: "nl", state: "Gelderland" } };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The times `openingHours` is open in the `days` days from `from` (in the server's time zone, Europe/Amsterdam).
 * An interval past midnight is one interval; the last one is cut at the end of the window. Undefined when the hours
 * are missing, can't be parsed, or are only "unknown"; an empty list when closed the whole window.
 */
export function openIntervals(openingHours: string | undefined, from: Date, days = 8): OpenInterval[] | undefined {
  if (!openingHours) return undefined;
  let intervals: [Date, Date, boolean, string | undefined][];
  try {
    const hours = new OpeningHours(openingHours, NOMINATIM as never);
    intervals = hours.getOpenIntervals(from, new Date(from.getTime() + days * DAY_MS));
  } catch {
    return undefined;
  }
  const known = intervals.filter(([, , unknown]) => !unknown);
  if (intervals.length && !known.length) return undefined;
  return known.map(([start, end]) => ({ start, end }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx --yes bun test src/services/fastfood.helpers.test.ts`
Expected: PASS (all tests). If the `opening_hours` type import complains in Step 6, the type of the constructor's 2nd parameter is `nominatim_object`; keep the `as never` cast.

- [ ] **Step 6: Typecheck and lint**

Run: `npx --yes bun x tsc --noEmit && npx --yes bun x eslint src/services/fastfood.helpers.ts src/services/fastfood.helpers.test.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/services/fastfood.helpers.ts src/services/fastfood.helpers.test.ts
git commit -m "feat(fastfood): OSM restaurant mapping and open intervals"
```

---

### Task 2: Overpass client + model

**Files:**
- Create: `src/services/fastfood.client.ts`
- Create: `src/models/fastfood.model.ts`
- Test: `src/services/fastfood.client.test.ts`

**Interfaces:**
- Consumes: `OVERPASS_QUERY`, `OverpassElement`, `Restaurant` (Task 1).
- Produces:
  - `class FastfoodUpstreamError extends Error`
  - `interface FastfoodApi { fetchElements(): Promise<OverpassElement[]> }`
  - `class OverpassClient implements FastfoodApi` — `constructor(fetchImpl: typeof fetch = fetch, timeoutMs = 120_000, endpoints = OVERPASS_ENDPOINTS)`
  - `OVERPASS_ENDPOINTS: string[]`
  - `fastfoodModel(connection: Connection): Model<FastfoodDoc>` with `type FastfoodDoc = Restaurant` stored in collection `fastfood`, unique index on `osmId`.

- [ ] **Step 1: Write the failing tests**

`src/services/fastfood.client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { FastfoodUpstreamError, OverpassClient } from "./fastfood.client";
import { OVERPASS_QUERY } from "./fastfood.helpers";

const ELEMENT = { type: "node", id: 1, lat: 52, lon: 5, tags: { "brand:wikidata": "Q38076" } };

function fakeFetch(answers: (Response | Error)[]) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("OverpassClient", () => {
  test("posts the query and returns the elements", async () => {
    const { impl, calls } = fakeFetch([Response.json({ elements: [ELEMENT] })]);
    const client = new OverpassClient(impl, 1000, ["https://a", "https://b"]);
    expect(await client.fetchElements()).toEqual([ELEMENT] as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://a");
    expect(new URLSearchParams(calls[0].body).get("data")).toBe(OVERPASS_QUERY);
  });

  test("falls back to the next endpoint on an error status or network error", async () => {
    const { impl, calls } = fakeFetch([new Response("busy", { status: 429 }), Response.json({ elements: [ELEMENT] })]);
    expect(await new OverpassClient(impl, 1000, ["https://a", "https://b"]).fetchElements()).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual(["https://a", "https://b"]);

    const second = fakeFetch([new Error("ECONNRESET"), Response.json({ elements: [] })]);
    expect(await new OverpassClient(second.impl, 1000, ["https://a", "https://b"]).fetchElements()).toEqual([]);
  });

  test("throws FastfoodUpstreamError when every endpoint fails", async () => {
    const { impl } = fakeFetch([new Response("x", { status: 500 }), new Response("not json", { status: 200 })]);
    await expect(new OverpassClient(impl, 1000, ["https://a", "https://b"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
  });

  test("an answer without elements array is a failure", async () => {
    const { impl } = fakeFetch([Response.json({ remark: "runtime error" })]);
    await expect(new OverpassClient(impl, 1000, ["https://a"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx --yes bun test src/services/fastfood.client.test.ts`
Expected: FAIL, `Cannot find module './fastfood.client'`.

- [ ] **Step 3: Implement the client**

`src/services/fastfood.client.ts`:

```ts
import { OVERPASS_QUERY, type OverpassElement } from "./fastfood.helpers";
import { errorText } from "../utils/error-text";

export const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const USER_AGENT = "jotihunt-tracker (fastfood layer)";

/** No Overpass endpoint answered something usable. */
export class FastfoodUpstreamError extends Error {}

export interface FastfoodApi {
  /** Every McDonald's, KFC and Burger King in the Netherlands. */
  fetchElements(): Promise<OverpassElement[]>;
}

/** OpenStreetMap through the public Overpass API (ODbL); tries the endpoints in order. */
export class OverpassClient implements FastfoodApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
    private readonly endpoints = OVERPASS_ENDPOINTS,
  ) {}

  async fetchElements(): Promise<OverpassElement[]> {
    const failures: string[] = [];
    for (const endpoint of this.endpoints) {
      try {
        return await this.fetchFrom(endpoint);
      } catch (error) {
        failures.push(`${endpoint}: ${errorText(error)}`);
      }
    }
    throw new FastfoodUpstreamError(`Overpass not reachable (${failures.join("; ")})`);
  }

  private async fetchFrom(endpoint: string): Promise<OverpassElement[]> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ data: OVERPASS_QUERY }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`answered ${response.status}`);
    }
    const body = (await response.json()) as { elements?: unknown };
    if (!Array.isArray(body.elements)) throw new Error("answered no elements");
    return body.elements as OverpassElement[];
  }
}
```

Note: `response.json()` on "not json" throws a SyntaxError inside the try, which counts as that endpoint failing.

- [ ] **Step 4: Implement the model**

`src/models/fastfood.model.ts`:

```ts
import mongoose, { type Connection, type Model } from "mongoose";
import type { Restaurant } from "../services/fastfood.helpers";

export type FastfoodDoc = Restaurant;

const FastfoodSchema = new mongoose.Schema<FastfoodDoc>(
  {
    osmId: { type: String, required: true, unique: true },
    brand: { type: String, required: true, enum: ["mcdonalds", "kfc", "burgerking"] },
    branch: String,
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
    },
    street: String,
    houseNumber: String,
    postcode: String,
    city: String,
    phone: String,
    website: String,
    driveThrough: Boolean,
    openingHours: String,
    updatedAt: { type: Date, required: true, index: true },
  },
  { collection: "fastfood", versionKey: false },
);

/**
 * McDonald's / KFC / Burger King from OpenStreetMap in the REAL database (the demo state store's connection), so the
 * cache survives demo mode; the test connection in tests.
 */
export function fastfoodModel(connection: Connection): Model<FastfoodDoc> {
  return (connection.models.Fastfood as Model<FastfoodDoc> | undefined) ?? connection.model<FastfoodDoc>("Fastfood", FastfoodSchema);
}
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npx --yes bun test src/services/fastfood.client.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun x eslint src/services/fastfood.client.ts src/services/fastfood.client.test.ts src/models/fastfood.model.ts`
Expected: tests PASS, no other output.

- [ ] **Step 6: Commit**

```bash
git add src/services/fastfood.client.ts src/services/fastfood.client.test.ts src/models/fastfood.model.ts
git commit -m "feat(fastfood): Overpass client with fallback endpoint and model"
```

---

### Task 3: FastfoodService — refresh, keep old data, list with intervals

**Files:**
- Create: `src/services/fastfood.service.ts`
- Test: `src/services/fastfood.service.test.ts`

**Interfaces:**
- Consumes: `FastfoodApi`, `FastfoodUpstreamError` (Task 2), `fastfoodModel` (Task 2), `toRestaurant`, `openIntervals`, `Restaurant`, `Brand` (Task 1), `ServiceLogger`, `serviceSlot`.
- Produces:
  - `interface FastfoodItem extends Omit<Restaurant, "updatedAt"> { updatedAt: string; intervals?: { start: string; end: string }[] }`
  - `class FastfoodService` — `constructor(options: { connection: Connection; client: FastfoodApi; logger: ServiceLogger; now?: () => Date; minCount?: number })`; `refresh(): Promise<boolean>` (true when stored); `refreshIfStale(): Promise<void>`; `list(): Promise<FastfoodItem[]>`; `start(): void` (refreshIfStale now + every hour); `stop(): void`.
  - `MIN_RESTAURANTS = 100`, `REFRESH_AFTER_MS = 24 h`, `LIST_CACHE_MS = 10 min`.
  - `setFastfoodService`, `getFastfoodService`, `requireFastfoodService` (service slot, 503 "Fastfood is niet beschikbaar op de server.").

- [ ] **Step 1: Write the failing tests**

`src/services/fastfood.service.test.ts`:

```ts
process.env.TZ = "Europe/Amsterdam";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { fastfoodModel } from "../models/fastfood.model";
import { FastfoodUpstreamError, type FastfoodApi } from "./fastfood.client";
import type { OverpassElement } from "./fastfood.helpers";
import { FastfoodService } from "./fastfood.service";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };

const element = (id: number, hours?: string): OverpassElement => ({
  type: "node",
  id,
  lat: 52 + id / 1000,
  lon: 5,
  tags: { "brand:wikidata": "Q38076", ...(hours ? { opening_hours: hours } : {}) },
});

class FakeApi implements FastfoodApi {
  elements: OverpassElement[] = [];
  fail = false;
  calls = 0;
  async fetchElements() {
    this.calls++;
    if (this.fail) throw new FastfoodUpstreamError("down");
    return this.elements;
  }
}

let db: Connection;
let api: FakeApi;
let clock: Date;
let service: FastfoodService;

beforeAll(async () => {
  db = await mongoose.createConnection(uri).asPromise();
  await fastfoodModel(db).syncIndexes();
});
beforeEach(async () => {
  await fastfoodModel(db).deleteMany({});
  api = new FakeApi();
  clock = new Date("2026-10-17T23:40:00+02:00");
  service = new FastfoodService({ connection: db, client: api, logger: silent, now: () => clock, minCount: 2 });
});
afterAll(async () => {
  service.stop();
  await db.close();
});

describe("refresh", () => {
  test("stores the restaurants, skipping unusable elements", async () => {
    api.elements = [element(1), element(2), { type: "node", id: 3, tags: { "brand:wikidata": "Q1" }, lat: 1, lon: 1 }];
    expect(await service.refresh()).toBe(true);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });

  test("a second refresh updates and drops restaurants that are gone", async () => {
    api.elements = [element(1), element(2), element(4)];
    await service.refresh();
    api.elements = [element(1, "24/7"), element(2)];
    clock = new Date(clock.getTime() + 1000);
    await service.refresh();
    const docs = await fastfoodModel(db).find().sort({ osmId: 1 }).lean();
    expect(docs.map((doc) => doc.osmId)).toEqual(["node/1", "node/2"]);
    expect(docs[0].openingHours).toBe("24/7");
  });

  test("Overpass down keeps the old data", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    api.fail = true;
    expect(await service.refresh()).toBe(false);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });

  test("fewer than minCount restaurants is a failure", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    api.elements = [element(1)];
    expect(await service.refresh()).toBe(false);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });
});

describe("refreshIfStale", () => {
  test("refreshes when empty or a day old, not otherwise", async () => {
    api.elements = [element(1), element(2)];
    await service.refreshIfStale();
    expect(api.calls).toBe(1);
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await service.refreshIfStale();
    expect(api.calls).toBe(1);
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    await service.refreshIfStale();
    expect(api.calls).toBe(2);
  });
});

describe("list", () => {
  test("adds intervals from now; unknown hours have none", async () => {
    api.elements = [element(1, "Mo-Su 10:00-01:00"), element(2)];
    await service.refresh();
    const items = await service.list();
    const open = items.find((item) => item.osmId === "node/1")!;
    // Saturday 23:40: the open interval Sat 10:00 – Sun 01:00, cut at "now" by getOpenIntervals
    expect(open.intervals?.[0]).toEqual({ start: "2026-10-17T21:40:00.000Z", end: "2026-10-17T23:00:00.000Z" });
    expect(open).not.toHaveProperty("_id");
    expect(typeof open.updatedAt).toBe("string");
    expect(items.find((item) => item.osmId === "node/2")).not.toHaveProperty("intervals");
  });

  test("is cached for 10 minutes", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    expect(await service.list()).toHaveLength(2);
    await fastfoodModel(db).deleteOne({ osmId: "node/1" });
    expect(await service.list()).toHaveLength(2);
    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    expect(await service.list()).toHaveLength(1);
  });

  test("a refresh clears the cache", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    expect(await service.list()).toHaveLength(2);
    api.elements = [element(1), element(2), element(3)];
    await service.refresh();
    expect(await service.list()).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx --yes bun test src/services/fastfood.service.test.ts`
Expected: FAIL, `Cannot find module './fastfood.service'`.

- [ ] **Step 3: Implement**

`src/services/fastfood.service.ts`:

```ts
import type { Connection, Model } from "mongoose";
import { fastfoodModel, type FastfoodDoc } from "../models/fastfood.model";
import type { FastfoodApi } from "./fastfood.client";
import { openIntervals, toRestaurant, type Restaurant } from "./fastfood.helpers";
import { errorText } from "../utils/error-text";
import type { ServiceLogger } from "../utils/service-logger";
import { serviceSlot } from "../utils/service-slot";

/** A refresh with fewer restaurants than this is a truncated or broken answer: keep the old data */
export const MIN_RESTAURANTS = 100;
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The list's intervals start at "now"; recomputing them every 10 minutes is plenty for an open/closed status */
export const LIST_CACHE_MS = 10 * 60 * 1000;

/** One restaurant as `GET /fastfood` answers it; `intervals` is absent when the opening hours are unknown. */
export interface FastfoodItem extends Omit<Restaurant, "updatedAt"> {
  updatedAt: string;
  intervals?: { start: string; end: string }[];
}

export interface FastfoodServiceOptions {
  /** Connection to the REAL database (the demo state store's), so the cache survives demo mode */
  connection: Connection;
  client: FastfoodApi;
  logger: ServiceLogger;
  /** Tests only */
  now?: () => Date;
  /** Tests only, default MIN_RESTAURANTS */
  minCount?: number;
}

/** McDonald's, KFC and Burger King from OpenStreetMap: refreshed daily, listed with their open intervals. */
export class FastfoodService {
  private readonly model: Model<FastfoodDoc>;
  private readonly now: () => Date;
  private readonly minCount: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: { at: number; items: FastfoodItem[] } | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly options: FastfoodServiceOptions) {
    this.model = fastfoodModel(options.connection);
    this.now = options.now ?? (() => new Date());
    this.minCount = options.minCount ?? MIN_RESTAURANTS;
  }

  /** Refresh now when the data is missing or a day old, then check again every hour. */
  start() {
    void this.refreshIfStale();
    this.timer = setInterval(() => void this.refreshIfStale(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshIfStale(): Promise<void> {
    const newest = await this.model.findOne().sort({ updatedAt: -1 }).select({ updatedAt: 1 }).lean();
    if (newest && this.now().getTime() - newest.updatedAt.getTime() < REFRESH_AFTER_MS) return;
    await this.refresh();
  }

  /** Fetch all restaurants and replace the stored ones; false (old data kept) when Overpass fails or answers too few. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const now = this.now();
    let restaurants: Restaurant[];
    try {
      const elements = await this.options.client.fetchElements();
      restaurants = elements.map((element) => toRestaurant(element, now)).filter((restaurant): restaurant is Restaurant => !!restaurant);
    } catch (error) {
      this.options.logger.warn(`Fastfood refresh failed, keeping the old data: ${errorText(error)}`);
      return false;
    }
    if (restaurants.length < this.minCount) {
      this.options.logger.warn(`Fastfood refresh got only ${restaurants.length} restaurants, keeping the old data`);
      return false;
    }
    await this.model.bulkWrite(restaurants.map((restaurant) => ({ replaceOne: { filter: { osmId: restaurant.osmId }, replacement: restaurant, upsert: true } })));
    await this.model.deleteMany({ osmId: { $nin: restaurants.map((restaurant) => restaurant.osmId) } });
    const unknown = restaurants.filter((restaurant) => openIntervals(restaurant.openingHours, now) === undefined).length;
    this.options.logger.info(`Fastfood refreshed: ${restaurants.length} restaurants, ${unknown} without usable opening hours`);
    this.cache = null;
    return true;
  }

  /** Every restaurant with its open intervals for the coming 8 days (cached for LIST_CACHE_MS). */
  async list(): Promise<FastfoodItem[]> {
    const now = this.now();
    if (this.cache && now.getTime() - this.cache.at < LIST_CACHE_MS) return this.cache.items;
    const docs = await this.model.find().select({ _id: 0 }).lean();
    const items = docs.map(({ updatedAt, ...restaurant }) => {
      const intervals = openIntervals(restaurant.openingHours, now);
      const item: FastfoodItem = { ...restaurant, updatedAt: updatedAt.toISOString() };
      if (intervals) item.intervals = intervals.map(({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() }));
      return item;
    });
    this.cache = { at: now.getTime(), items };
    return items;
  }
}

const slot = serviceSlot<FastfoodService>("Fastfood is niet beschikbaar op de server.");
export const setFastfoodService = slot.set;
export const getFastfoodService = slot.get;
export const requireFastfoodService = slot.require;
```

- [ ] **Step 4: Run the tests**

Run: `npx --yes bun test src/services/fastfood.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx --yes bun x tsc --noEmit && npx --yes bun x eslint src/services/fastfood.service.ts src/services/fastfood.service.test.ts`

```bash
git add src/services/fastfood.service.ts src/services/fastfood.service.test.ts
git commit -m "feat(fastfood): service with daily refresh, old-data fallback and interval list"
```

---

### Task 4: Route + startup wiring

**Files:**
- Create: `src/controllers/fastfood.controller.ts`
- Create: `src/routes/fastfood.route.ts`
- Modify: `src/app.ts` (import + `app.use("/fastfood", fastfoodRoute);` after `/teams`)
- Modify: `src/index.ts` (create + start the service after the 3D buildings block, ~line 171)
- Test: `src/routes/fastfood.route.test.ts`

**Interfaces:**
- Consumes: `FastfoodService`, `setFastfoodService`, `requireFastfoodService` (Task 3), `OverpassClient` (Task 2).
- Produces: `GET /fastfood` → `200 FastfoodItem[]`, `401` without login, `503` without service.

- [ ] **Step 1: Write the failing test**

`src/routes/fastfood.route.test.ts`:

```ts
process.env.TZ = "Europe/Amsterdam";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose, { type Connection } from "mongoose";
import { fastfoodModel } from "../models/fastfood.model";
import { User } from "../models/user.model";
import type { FastfoodApi } from "../services/fastfood.client";
import { FastfoodService, setFastfoodService } from "../services/fastfood.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
const api: FastfoodApi = {
  fetchElements: async () => [
    { type: "node", id: 1, lat: 52, lon: 5, tags: { "brand:wikidata": "Q524757", opening_hours: "24/7" } },
    { type: "node", id: 2, lat: 52.1, lon: 5.1, tags: { "brand:wikidata": "Q177054" } },
  ],
};

let server: Server;
let base: string;
let db: Connection;

beforeAll(async () => {
  await connectTestDb();
  db = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await fastfoodModel(db).deleteMany({});
});
afterEach(() => setFastfoodService(null));
afterAll(async () => {
  server.close();
  await db.close();
  await disconnectTestDb();
});

const createUser = async () => withSession(await User.create({ name: "Hunter" }));

describe("GET /fastfood", () => {
  test("needs a login", async () => {
    expect((await fetch(`${base}/fastfood`)).status).toBe(401);
  });

  test("503 without the service", async () => {
    const token = tokenFor(await createUser());
    expect((await fetch(`${base}/fastfood`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(503);
  });

  test("lists the restaurants with intervals", async () => {
    const service = new FastfoodService({ connection: db, client: api, logger: silent, minCount: 1 });
    await service.refresh();
    setFastfoodService(service);
    const token = tokenFor(await createUser());
    const res = await fetch(`${base}/fastfood`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const items = (await res.json()) as { osmId: string; brand: string; intervals?: unknown[] }[];
    expect(items.map((item) => [item.osmId, item.brand]).sort()).toEqual([["node/1", "kfc"], ["node/2", "burgerking"]]);
    expect(items.find((item) => item.osmId === "node/1")!.intervals).toHaveLength(1);
    expect(items.find((item) => item.osmId === "node/2")).not.toHaveProperty("intervals");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx --yes bun test src/routes/fastfood.route.test.ts`
Expected: FAIL — the "lists" and "503" tests get 404 (route missing).

- [ ] **Step 3: Controller + route**

`src/controllers/fastfood.controller.ts`:

```ts
import { Request, Response } from "express";
import { ServiceError } from "../http/service-error";
import { requireFastfoodService } from "../services/fastfood.service";

/** Every McDonald's, KFC and Burger King with its open intervals (the map's fastfood layers). */
export async function list(_req: Request, res: Response) {
  try {
    const items = await requireFastfoodService().list();
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json(items);
  } catch (error) {
    if (error instanceof ServiceError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
```

`src/routes/fastfood.route.ts`:

```ts
import express from "express";
import * as fastfoodController from "../controllers/fastfood.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

router.get("/", [verifyToken], fastfoodController.list);

export default router;
```

- [ ] **Step 4: Mount in `src/app.ts`**

Add next to the other route imports:

```ts
import fastfoodRoute from "./routes/fastfood.route";
```

and right after `app.use("/teams", teamsRoute);`:

```ts
app.use("/fastfood", fastfoodRoute);
```

- [ ] **Step 5: Start the service in `src/index.ts`**

Next to the buildings imports:

```ts
import { OverpassClient } from "./services/fastfood.client";
import { FastfoodService, setFastfoodService } from "./services/fastfood.service";
```

After `setBuildingsService(buildings);`:

```ts
// Fastfood layers: McDonald's, KFC and Burger King from OpenStreetMap, refreshed daily in the real database
const fastfood = new FastfoodService({ connection: getDemoStateStore().connection, client: new OverpassClient(), logger: serviceLogger });
setFastfoodService(fastfood);
fastfood.start();
```

- [ ] **Step 6: Run the route test, the full suite, typecheck, lint**

Run: `npx --yes bun test src/routes/fastfood.route.test.ts && npx --yes bun test && npx --yes bun x tsc --noEmit && npx --yes bun x eslint .`
Expected: all PASS / no output. (The full suite must stay green; note the count.)

- [ ] **Step 7: Live smoke test against Overpass (no DB writes to the live stack)**

```bash
cat > /tmp/ff-smoke.ts <<'EOF'
process.env.TZ = "Europe/Amsterdam";
import { OverpassClient } from "./src/services/fastfood.client";
import { openIntervals, toRestaurant } from "./src/services/fastfood.helpers";
const now = new Date();
const restaurants = (await new OverpassClient().fetchElements()).map((e) => toRestaurant(e, now)).filter(Boolean);
console.log("restaurants", restaurants.length, "with intervals", restaurants.filter((r) => openIntervals(r!.openingHours, now)).length);
EOF
cp /tmp/ff-smoke.ts ./ff-smoke.ts && npx --yes bun ff-smoke.ts; rm ff-smoke.ts
```

Expected: `restaurants` between 400 and 900, `with intervals` a clear majority. Report the numbers.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/fastfood.controller.ts src/routes/fastfood.route.ts src/routes/fastfood.route.test.ts src/app.ts src/index.ts
git commit -m "feat(fastfood): GET /fastfood and start the service at boot"
```
