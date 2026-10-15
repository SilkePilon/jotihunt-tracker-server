# Intel AI chat (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET/POST/DELETE /intel-chat/:articleId`: a per-user, per-item Gemini chat that streams an AI SDK UI message stream and answers with read-only tools (app data, geo, web, code) and proposal tools the client renders as cards.

**Architecture:** `streamText` (ai 7.0.x, `@ai-sdk/google`) with our own function tools, converted with `toUIMessageStream` and written with `pipeUIMessageStreamToResponse`. Conversations live in a new `IntelChat` collection (one document per user per item) and are saved in the stream's `onEnd` (also after an abort). Code lives in `src/services/intel-chat/` (geo helpers, data loaders, prompt, message rules, agent, tools in `tools/`), the HTTP layer in `src/controllers/intel-chat.controller.ts` + `src/routes/intel-chat.route.ts`. Gemini built-in tools (Google Search, code execution) only run in their own `generateText` sub-calls inside `webSearch` / `runCode`.

**Tech Stack:** Bun tests (`bun:test`), TypeScript, Express 5, Mongoose 9, `ai` 7.0.127 (`streamText`, `toUIMessageStream`, `pipeUIMessageStreamToResponse`, `convertToModelMessages`, `tool`, `jsonSchema`, `isStepCount`), `@ai-sdk/google` 4.0.87 (`google.tools.googleSearch` / `codeExecution`, `thinkingConfig`), `ai/test` (`MockLanguageModelV4`), proj4 (via `rd-answer.ts`), turf.

Spec: `jotihunt-tracker-client/docs/superpowers/specs/2026-10-15-intel-ai-chat-design.md`. Contract (binding names and shapes): `jotihunt-tracker-client/docs/superpowers/specs/2026-10-15-intel-ai-chat-contract.md`.

## Global Constraints

- Repo `jotihunt-tracker-server`, branch `feat/intel-ai-chat` from `main` (Task 1). Do not deploy, do not push unless asked.
- bun is NOT on PATH: tests `npx --yes bun test <path>`, typecheck `npx --yes bun x tsc --noEmit`, lint `npx --yes bun run lint`. Tests need the local MongoDB (`docker compose up -d` in this repo; test DB `MONGO_URI_TEST`, default `mongodb://localhost:27017/jotihunt-test`). Database test files share one test database: run them one command at a time, never two `bun test` commands in parallel.
- Validation with `jsonSchema()` from `ai` (no zod). Prettier width 200 (lint enforces it).
- Routes: all behind `verifyToken`. Errors are JSON `{ error }`: `400 invalid_message`, `404 not_found`, `429 rate_limited` (30 POSTs / 10 min / user), `503 ai_unavailable` (no `GEMINI_API_KEY`). `DELETE` → `204`.
- POST body `{ message: UIMessage, web: boolean, deep: boolean }`; a user message has exactly one `text` part and at most one `file` part (`image/jpeg|png|webp`, `data:` URL, decoded ≤ 2 MB). The stream's `originalMessages` = stored history + new message. A POST whose `message.id` is already stored (client "Opnieuw") replaces that message and everything after it, never duplicates.
- Tool names (binding): `getItem`, `searchIntel`, `getHintBoard`, `getAreas`, `getFoxHistory`, `getOurTeams`, `convertCoordinates`, `checkPoint`, `nearbyGroups`, `distance`, `projectPoint`, `geocode`, `reverseGeocode`, `webSearch`, `readWebPage`, `runCode`, `showPoint`, `proposeHintAnswer`. Every tool output is its success shape or `{ error: string }`; tools never throw into the stream.
- Output shapes the client renders (binding): `PointResult`, `HintAnswerProposal`, `CheckPointResult`, `WebSearchResult` exactly as in the contract; `nearbyGroups` → `{ groups: NearGroup[] }`; `searchIntel` → `{ results: { articleId, title, kind, publishAt, snippet }[] }`.
- The AI never writes app data. Proposals only return data; "Zet als antwoord" uses the existing `POST /hints/:articleId/:area/solve`.
- Models: normal `createModels()("chat")`; `deep` → `("prediction")` with `providerOptions.google.thinkingConfig.thinkingLevel = "high"`; `stopWhen: isStepCount(12)`; web tools (`webSearch`, `readWebPage`) only in `activeTools` when `web` is true. Model history = last 40 messages.
- Item images: same rules as summaries (`fetchImages`: ≤ 20, 5 MB each, 14 MB total, https on jotihunt.net/.nl), attached to the first user message sent to the model; text-only fallback.
- Dutch user-facing texts; never send raw Gemini errors (use `toGeminiError(...).message`).
- Commits end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the `-m` pairs below do that).

## Priority-1 cut

Tasks 1-9 are the P1 cut: every P1 tool (`getItem`, `searchIntel`, `getHintBoard`, `getAreas`, `convertCoordinates`, `checkPoint`, `nearbyGroups`, `webSearch`, `showPoint`, `proposeHintAnswer`), the agent and the three routes. After Task 9 the feature is complete and shippable. Tasks 10-14 add the non-P1 tools one group at a time (each leaves the suite green); Task 15 is the final check.

## File map

| File | Responsibility |
| --- | --- |
| `src/models/intel-chat.model.ts` | `IntelChat { userId, articleId, messages (Mixed[]), updatedAt }`, unique `(userId, articleId)` |
| `src/services/intel-chat/store.ts` | `loadChat` / `saveChat` / `clearChat` |
| `src/services/intel-chat/geo.ts` | Pure geo: parse/format coordinates, area estimate (convex hulls in RD), nearest groups, NL box; later projection/bearing |
| `src/services/intel-chat/data.ts` | DB/live loaders: groups, solved hint points, trackers (Traccar/demo + Life360) |
| `src/services/intel-chat/point.ts` | `PointResult` / `CheckPointResult` builders |
| `src/services/intel-chat/tools/context.ts` | `IntelToolContext`, `ToolInputError`, `safely()` |
| `src/services/intel-chat/tools/app-data.ts` | `getItem`, `searchIntel`, `getHintBoard`, `getAreas` (+ later `getFoxHistory`, `getOurTeams`), `ItemView` |
| `src/services/intel-chat/tools/map.ts` | `convertCoordinates`, `checkPoint`, `nearbyGroups` (+ later `distance`, `projectPoint`, `geocode`, `reverseGeocode`) |
| `src/services/intel-chat/tools/proposals.ts` | `showPoint`, `proposeHintAnswer` |
| `src/services/intel-chat/tools/web.ts` | `webSearch` (+ later `readWebPage`), `WEB_TOOL_NAMES` |
| `src/services/intel-chat/tools/puzzle.ts` | `runCode` (later) |
| `src/services/intel-chat/tools/index.ts` | `createIntelTools`, `activeToolNames` |
| `src/services/intel-chat/prompt.ts` | Dutch system prompt (rules distilled from `docs/02`, `docs/04`) |
| `src/services/intel-chat/messages.ts` | Incoming message validation, retry truncation, storage rules, model window, item images in the model messages |
| `src/services/intel-chat/item-images.ts` | Item image download with a 10-minute cache |
| `src/services/intel-chat/agent.ts` | `streamIntelChat`: one turn as a UI message stream |
| `src/services/intel-chat/instance.ts` | Models and tool deps of the running server (settable in tests) |
| `src/services/intel-chat/pdok.client.ts` | PDOK Locatieserver free/reverse (later) |
| `src/services/intel-chat/web-fetch.ts` | SSRF-guarded page reader (later) |
| `src/controllers/intel-chat.controller.ts`, `src/routes/intel-chat.route.ts` | HTTP |
| `src/test/tools.ts`, `src/test/ai.ts` | Test helpers: `runTool`, `mockStreamModel` |

---

### Task 1: Branch, IntelChat model and store (P1)

**Files:**
- Create: `src/models/intel-chat.model.ts`, `src/services/intel-chat/store.ts`
- Test: `src/services/intel-chat/store.test.ts`

**Interfaces:**
- Produces: `IntelChat` model; `loadChat(userId, articleId): Promise<UIMessage[]>`, `saveChat(userId, articleId, messages: UIMessage[]): Promise<void>` (upsert), `clearChat(userId, articleId): Promise<void>`; `userId` is `mongoose.Types.ObjectId | string`.

- [ ] **Step 1: Create the branch**

```bash
cd "/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server"
git checkout main && git pull --ff-only
git checkout -b feat/intel-ai-chat
docker compose up -d   # local MongoDB for the tests
```

- [ ] **Step 2: Write the failing test** `src/services/intel-chat/store.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import mongoose from "mongoose";
import { IntelChat } from "../../models/intel-chat.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { clearChat, loadChat, saveChat } from "./store";

const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("intel chat store", () => {
  test("empty until saved; saved per user and item; replaced on the next save", async () => {
    expect(await loadChat(alice, 1)).toEqual([]);
    await saveChat(alice, 1, [message("m1", "hoi")]);
    await saveChat(bob, 1, [message("b1", "andere gebruiker")]);
    await saveChat(alice, 2, [message("m2", "ander item")]);
    expect(await loadChat(alice, 1)).toEqual([message("m1", "hoi")]);
    await saveChat(alice, 1, [message("m1", "hoi"), message("m3", "nog een")]);
    expect((await loadChat(alice, 1)).map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(await IntelChat.countDocuments()).toBe(3);
  });

  test("clearChat removes only that user's chat about that item", async () => {
    await saveChat(alice, 1, [message("m1", "hoi")]);
    await saveChat(bob, 1, [message("b1", "hoi")]);
    await clearChat(alice, 1);
    expect(await loadChat(alice, 1)).toEqual([]);
    expect(await loadChat(bob, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/store.test.ts`
Expected: FAIL (cannot find module `../../models/intel-chat.model`).

- [ ] **Step 4: Create the model** `src/models/intel-chat.model.ts`

```ts
import mongoose from "mongoose";

/** One user's AI chat about one Intel item (private; "Nieuw gesprek" deletes it). Messages are AI SDK UIMessages. */
const IntelChatSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    articleId: { type: Number, required: true },
    messages: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    updatedAt: { type: Date, required: true },
  },
  { minimize: false },
);

IntelChatSchema.index({ userId: 1, articleId: 1 }, { unique: true });

export const IntelChat = mongoose.model("IntelChat", IntelChatSchema);
```

The demo database switch builds indexes for every registered model (`database-switch.ts`), so nothing else needs registering.

- [ ] **Step 5: Create the store** `src/services/intel-chat/store.ts`

```ts
import type { UIMessage } from "ai";
import type mongoose from "mongoose";
import { IntelChat } from "../../models/intel-chat.model";

type UserId = mongoose.Types.ObjectId | string;

/** The user's chat about an item; empty when there is none */
export async function loadChat(userId: UserId, articleId: number): Promise<UIMessage[]> {
  const chat = await IntelChat.findOne({ userId, articleId }, { _id: 0, messages: 1 }).lean();
  return (chat?.messages ?? []) as UIMessage[];
}

/** Replace the stored messages (creates the chat on first save) */
export async function saveChat(userId: UserId, articleId: number, messages: UIMessage[]): Promise<void> {
  await IntelChat.updateOne({ userId, articleId }, { $set: { messages, updatedAt: new Date() } }, { upsert: true });
}

export async function clearChat(userId: UserId, articleId: number): Promise<void> {
  await IntelChat.deleteOne({ userId, articleId });
}
```

- [ ] **Step 6: Run the test and typecheck**

Run: `npx --yes bun test src/services/intel-chat/store.test.ts && npx --yes bun x tsc --noEmit`
Expected: 2 pass, 0 fail; tsc prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/models/intel-chat.model.ts src/services/intel-chat/store.ts src/services/intel-chat/store.test.ts
git commit -m "feat(intel-chat): IntelChat model and conversation store" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 2: Geo helpers (P1)

**Files:**
- Modify: `src/services/rd-answer.ts` (add `fromRd`)
- Create: `src/services/intel-chat/geo.ts`
- Test: `src/services/intel-chat/geo.test.ts`

**Interfaces:**
- Produces (all pure):
  - `fromRd(x, y): { lng, lat }` in `rd-answer.ts`
  - types `LatLng { lat, lng }`, `Rd { x, y }`, `CoordinateKind = "rd" | "decimal" | "dms"`, `ParsedCoordinate { kind, latLng, rd }`, `FormattedCoordinate { rd8, rdFull, decimal, dm }`, `AreaGroup { name, area: string | null, lat, lng }`, `NearGroup { name, area, distanceM }`, `AreaEstimate { area: string | null, method: "hull" | "nearest-group" | "none" }`
  - `parseCoordinate(input: string): ParsedCoordinate | null`, `coordinateAt(latLng): ParsedCoordinate`, `formatCoordinate(parsed): FormattedCoordinate`, `insideNl(latLng): boolean`, `metresBetween(a, b): number`, `nearestGroups(point, groups, count): NearGroup[]`, `groupsWithin(point, groups, radiusM): NearGroup[]`, `convexHull(points)`, `distanceToHull(p, hull)`, `HULL_BUFFER_M = 1000`, `estimateArea(point, groups): AreaEstimate`

Decisions: the area estimate works in RD metres (a planar grid in metres), so "hull buffered 1 km" is "distance to the convex hull ≤ 1000 m" and needs no extra turf packages (`@turf/convex`/`@turf/buffer` are not installed). `insideNl` is a bounding box of the Netherlands (no border polygon is available offline); the name in the output stays `insideNl` per the contract.

- [ ] **Step 1: Add `fromRd`** at the end of `src/services/rd-answer.ts`

```ts
/** WGS84 position of RD coordinates (metres). */
export function fromRd(x: number, y: number): { lng: number; lat: number } {
  const [lng, lat] = proj4("RD", "WGS84", [x, y]);
  return { lng, lat };
}
```

- [ ] **Step 2: Write the failing test** `src/services/intel-chat/geo.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { toRd } from "../rd-answer";
import { convexHull, distanceToHull, estimateArea, formatCoordinate, groupsWithin, insideNl, nearestGroups, parseCoordinate, type AreaGroup } from "./geo";

/** HQ Jotihunt, Stikkerstraat Arnhem (RD 188362 440722) */
const HQ = { lat: 51.95392, lng: 5.87252 };

describe("parseCoordinate", () => {
  test("RD in 4, 5 and 6 digits, with separators, dots, slash or glued", () => {
    for (const input of ["1883 4407", "18836 44072", "188362 440722", "188.362/440.722", "188362,440722", "RD: 188362 440722", "18834407", "188362440722"]) {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("rd");
      expect(Math.abs(parsed!.rd.x - 188362)).toBeLessThan(100);
      expect(Math.abs(parsed!.rd.y - 440722)).toBeLessThan(100);
      expect(Math.abs(parsed!.latLng.lat - HQ.lat)).toBeLessThan(0.002);
      expect(Math.abs(parsed!.latLng.lng - HQ.lng)).toBeLessThan(0.002);
    }
  });

  test("RD keeps the exact metres it was given", () => {
    expect(parseCoordinate("188362 440722")!.rd).toEqual({ x: 188362, y: 440722 });
    expect(parseCoordinate("1883 4407")!.rd).toEqual({ x: 188300, y: 440700 });
  });

  test("decimal degrees, also lng first and with decimal commas", () => {
    for (const input of ["51.95392, 5.87252", "51.95392 5.87252", "5.87252, 51.95392", "51,95392 5,87252"]) {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("decimal");
      expect(parsed!.latLng.lat).toBeCloseTo(51.95392, 5);
      expect(parsed!.latLng.lng).toBeCloseTo(5.87252, 5);
    }
  });

  test("degrees and minutes (and seconds) with hemisphere letters before or after", () => {
    const expectNear = (input: string, lat: number, lng: number) => {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("dms");
      expect(parsed!.latLng.lat).toBeCloseTo(lat, 5);
      expect(parsed!.latLng.lng).toBeCloseTo(lng, 5);
    };
    expectNear("N 52° 12.345 E 005° 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear("N52 12.345 E5 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear(`52°12'30"N 5°52'10"E`, 52 + 12 / 60 + 30 / 3600, 5 + 52 / 60 + 10 / 3600);
    expectNear("52°12,345' 5°52,123'", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear("N 52° 12.345 O 5° 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
  });

  test("nonsense, out of range and unequal RD halves give null", () => {
    for (const input of ["", "hallo", "1234 56789", "999999 999999", "123 456", "N 95° 00.000 E 5° 00.000", "52° 75.000 5° 10.000"]) {
      expect(parseCoordinate(input)).toBeNull();
    }
  });
});

describe("formatCoordinate", () => {
  test("gives the 8-digit answer, full RD, decimal and degrees-minutes", () => {
    const formatted = formatCoordinate(parseCoordinate("188362 440722")!);
    expect(formatted.rd8).toBe("1884 4407");
    expect(formatted.rdFull).toBe("188362 440722");
    expect(formatted.decimal).toMatch(/^51\.95\d{3}, 5\.87\d{3}$/);
    expect(formatted.dm).toMatch(/^N 51° 57\.\d{3}' E 5° 52\.\d{3}'$/);
  });
});

describe("insideNl", () => {
  test("a rough box around the Netherlands", () => {
    expect(insideNl(HQ)).toBe(true);
    expect(insideNl({ lat: 48.85, lng: 2.35 })).toBe(false);
  });
});

/** Groups on a 3x3 km grid east and west of a centre, in RD metres */
function groupAt(name: string, area: string | null, dx: number, dy: number): AreaGroup {
  const base = toRd(HQ.lng, HQ.lat);
  const parsed = parseCoordinate(`${Math.round(base.x + dx)} ${Math.round(base.y + dy)}`)!;
  return { name, area, ...parsed.latLng };
}
const pointAt = (dx: number, dy: number) => {
  const { lat, lng } = groupAt("p", null, dx, dy);
  return { lat, lng };
};

const GROUPS: AreaGroup[] = [
  groupAt("W1", "alpha", -10_000, 0),
  groupAt("W2", "alpha", -10_000, 3000),
  groupAt("W3", "alpha", -7000, 1500),
  groupAt("E1", "bravo", 10_000, 0),
  groupAt("E2", "bravo", 10_000, 3000),
  groupAt("E3", "bravo", 7000, 1500),
  groupAt("X", null, 0, 20_000),
];

describe("convexHull / distanceToHull", () => {
  test("hull of a square drops the inner point; distance 0 inside, to the edge outside", () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ]);
    expect(hull).toHaveLength(4);
    expect(distanceToHull([5, 5], hull)).toBe(0);
    expect(distanceToHull([15, 5], hull)).toBeCloseTo(5);
  });

  test("one point and a segment work as hulls too", () => {
    expect(distanceToHull([3, 4], [[0, 0]])).toBeCloseTo(5);
    expect(
      distanceToHull(
        [5, 3],
        [
          [0, 0],
          [10, 0],
        ],
      ),
    ).toBeCloseTo(3);
  });
});

describe("estimateArea", () => {
  test("inside one area's hull (or within 1 km of it) → hull", () => {
    expect(estimateArea(pointAt(-9000, 1500), GROUPS)).toEqual({ area: "alpha", method: "hull" });
    expect(estimateArea(pointAt(-6200, 1500), GROUPS)).toEqual({ area: "alpha", method: "hull" });
  });

  test("outside every hull → the nearest group's area", () => {
    expect(estimateArea(pointAt(4000, 1500), GROUPS)).toEqual({ area: "bravo", method: "nearest-group" });
  });

  test("no group has an area → none", () => {
    expect(estimateArea(HQ, [groupAt("X", null, 0, 0)])).toEqual({ area: null, method: "none" });
  });
});

describe("nearestGroups / groupsWithin", () => {
  test("sorted by distance, rounded metres", () => {
    const nearest = nearestGroups(pointAt(6500, 1200), GROUPS, 2);
    expect(nearest.map((group) => group.name)).toEqual(["E3", "E1"]);
    expect(nearest[0].distanceM).toBeGreaterThan(400);
    expect(nearest[0].distanceM).toBeLessThan(700);
    expect(Number.isInteger(nearest[0].distanceM)).toBe(true);
  });

  test("groupsWithin keeps only groups inside the radius", () => {
    expect(groupsWithin(pointAt(6500, 1200), GROUPS, 4000).map((group) => group.name)).toEqual(["E3", "E1", "E2"]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/geo.test.ts`
Expected: FAIL (cannot find module `./geo`).

- [ ] **Step 4: Implement** `src/services/intel-chat/geo.ts`

```ts
import { distanceM } from "../prediction/geo";
import { formatRdAnswer, fromRd, toRd } from "../rd-answer";

export type LatLng = { lat: number; lng: number };
export type Rd = { x: number; y: number };
export type CoordinateKind = "rd" | "decimal" | "dms";

export interface ParsedCoordinate {
  kind: CoordinateKind;
  latLng: LatLng;
  rd: Rd;
}

export interface FormattedCoordinate {
  /** Jotihunt answer format in hectometres, "XXXX YYYY" */
  rd8: string;
  /** Full RD in metres, "XXXXXX YYYYYY" */
  rdFull: string;
  /** "52.01234, 5.87654" */
  decimal: string;
  /** Degrees and decimal minutes, "N 52° 00.740' E 5° 52.592'" */
  dm: string;
}

/** RD bounds parseRdAnswer accepts too (metres) */
const RD_X = [0, 290_000];
const RD_Y = [290_000, 630_000];
/** Digits per RD half: 4 = hectometres, 5 = decametres, 6 = metres */
const RD_SCALE: Record<number, number> = { 4: 100, 5: 10, 6: 1 };

const inRdBounds = ({ x, y }: Rd) => x >= RD_X[0] && x <= RD_X[1] && y >= RD_Y[0] && y <= RD_Y[1];
const validLatLng = ({ lat, lng }: LatLng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
/** A lat/lng pair written the other way round (lng first) is turned when only that order lands in the Netherlands */
const looksSwapped = (a: number, b: number) => a >= 2 && a <= 8 && b >= 50 && b <= 54;

/** RD: "1523 4311", "15234 43111", "152341 431112", "152.341/431.112", "15234311", "152341431112" (optionally "RD:" first) */
function parseRd(text: string): Rd | null {
  const cleaned = text
    .trim()
    .replace(/^rd\s*:?\s*/i, "")
    // thousands separators: "152.341" → "152341"
    .replace(/(\d)\.(\d{3})(?!\d)/g, "$1$2");
  const parts = cleaned.split(/[\s,;/]+/).filter(Boolean);
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  let xs: string;
  let ys: string;
  if (parts.length === 1 && [8, 10, 12].includes(parts[0].length)) {
    const half = parts[0].length / 2;
    xs = parts[0].slice(0, half);
    ys = parts[0].slice(half);
  } else if (parts.length === 2 && parts[0].length === parts[1].length && RD_SCALE[parts[0].length]) {
    [xs, ys] = parts;
  } else {
    return null;
  }
  const scale = RD_SCALE[xs.length];
  const rd = { x: Number(xs) * scale, y: Number(ys) * scale };
  return inRdBounds(rd) ? rd : null;
}

/** Decimal degrees: "52.0123, 5.8765", "52.0123 5.8765", "52,0123 5,8765" (lng first is turned round in NL) */
function parseDecimal(text: string): LatLng | null {
  const match =
    /^\s*(-?\d{1,3}\.\d+)\s*[,;\s/]\s*(-?\d{1,3}\.\d+)\s*$/.exec(text) ?? /^\s*(-?\d{1,3},\d+)\s*[;\s/]\s*(-?\d{1,3},\d+)\s*$/.exec(text);
  if (!match) return null;
  const a = Number(match[1].replace(",", "."));
  const b = Number(match[2].replace(",", "."));
  const latLng = looksSwapped(a, b) ? { lat: b, lng: a } : { lat: a, lng: b };
  return validLatLng(latLng) ? latLng : null;
}

/** Degrees (+ minutes (+ seconds)) of one half, e.g. "52° 12.345'" or "52 12 30" */
function dmsValue(half: string): number | null {
  const numbers = half.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length === 0 || numbers.length > 3) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (minutes >= 60 || seconds >= 60) return null;
  return degrees + minutes / 60 + seconds / 3600;
}

/**
 * Degrees with minutes (and seconds): "N 52° 12.345 E 005° 52.123", "52°12'30\"N 5°52'10\"E", "52°12,345' 5°52,123'".
 * Hemisphere letters N/S and E/O/W may come before or after each half.
 */
function parseDms(text: string): LatLng | null {
  const s = text.toUpperCase().replace(/(\d),(\d)/g, "$1.$2");
  const hasLetters = /[NS]/.test(s) && /[EOW]/.test(s);
  if (!hasLetters && !/[°º]/.test(s)) return null;
  let latHalf: string;
  let lngHalf: string;
  let latSign = 1;
  let lngSign = 1;
  if (hasLetters) {
    const letters = [...s.matchAll(/[NSEOW]/g)];
    if (letters.length !== 2) return null;
    const pieces = s.split(/[NSEOW]/);
    // "N 52 12.345 E 5 52.123" → ["", " 52 12.345 ", " 5 52.123"]: each half follows its letter
    const prefix = !/\d/.test(pieces[0]);
    const halves = prefix ? [pieces[1], pieces[2]] : [pieces[0], pieces[1]];
    const latFirst = /[NS]/.test(letters[0][0]);
    [latHalf, lngHalf] = latFirst ? halves : [halves[1], halves[0]];
    const latLetter = latFirst ? letters[0][0] : letters[1][0];
    const lngLetter = latFirst ? letters[1][0] : letters[0][0];
    if (!/[NS]/.test(latLetter) || !/[EOW]/.test(lngLetter)) return null;
    latSign = latLetter === "S" ? -1 : 1;
    lngSign = lngLetter === "W" ? -1 : 1;
  } else {
    const halves = s.split(/(?=\b\d+(?:\.\d+)?\s*[°º])/).filter((half) => /\d/.test(half));
    if (halves.length !== 2) return null;
    [latHalf, lngHalf] = halves;
  }
  const a = dmsValue(latHalf);
  const b = dmsValue(lngHalf);
  if (a === null || b === null) return null;
  const latLng = !hasLetters && looksSwapped(a, b) ? { lat: b, lng: a } : { lat: latSign * a, lng: lngSign * b };
  return validLatLng(latLng) ? latLng : null;
}

/** A coordinate in any format the team uses (RD, decimal degrees, degrees-minutes(-seconds)), or null */
export function parseCoordinate(input: string): ParsedCoordinate | null {
  const text = input.trim();
  if (!text || text.length > 100) return null;
  const dms = parseDms(text);
  if (dms) return { kind: "dms", latLng: dms, rd: toRd(dms.lng, dms.lat) };
  const decimal = parseDecimal(text);
  if (decimal) return { kind: "decimal", latLng: decimal, rd: toRd(decimal.lng, decimal.lat) };
  const rd = parseRd(text);
  if (rd) {
    const { lat, lng } = fromRd(rd.x, rd.y);
    return { kind: "rd", latLng: { lat, lng }, rd };
  }
  return null;
}

/** A point in WGS84 with its RD coordinates */
export function coordinateAt(latLng: LatLng): ParsedCoordinate {
  return { kind: "decimal", latLng, rd: toRd(latLng.lng, latLng.lat) };
}

function dm(value: number, positive: string, negative: string): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Number(((abs - degrees) * 60).toFixed(3));
  if (minutes >= 60) {
    degrees += 1;
    minutes = 0;
  }
  return `${value < 0 ? negative : positive} ${degrees}° ${minutes.toFixed(3).padStart(6, "0")}'`;
}

export function formatCoordinate({ latLng, rd }: ParsedCoordinate): FormattedCoordinate {
  const full = (value: number) => String(Math.round(value)).padStart(6, "0");
  return {
    rd8: formatRdAnswer(latLng.lng, latLng.lat),
    rdFull: `${full(rd.x)} ${full(rd.y)}`,
    decimal: `${latLng.lat.toFixed(5)}, ${latLng.lng.toFixed(5)}`,
    dm: `${dm(latLng.lat, "N", "S")} ${dm(latLng.lng, "E", "W")}`,
  };
}

/** Rough check: inside the bounding box of the Netherlands (not its border) */
export function insideNl({ lat, lng }: LatLng): boolean {
  return lat >= 50.75 && lat <= 53.56 && lng >= 3.36 && lng <= 7.23;
}

/** Metres between two points (great circle), rounded */
export function metresBetween(a: LatLng, b: LatLng): number {
  return Math.round(distanceM([a.lng, a.lat], [b.lng, b.lat]));
}

/** A scouting group as the geo helpers need it; `area` lowercase (e.g. "alpha") or null */
export interface AreaGroup {
  name: string;
  area: string | null;
  lat: number;
  lng: number;
}

export interface NearGroup {
  name: string;
  area: string | null;
  distanceM: number;
}

export interface AreaEstimate {
  area: string | null;
  method: "hull" | "nearest-group" | "none";
}

/** The `count` groups nearest to the point, nearest first */
export function nearestGroups(point: LatLng, groups: AreaGroup[], count: number): NearGroup[] {
  return groups
    .map((group) => ({ name: group.name, area: group.area, distanceM: metresBetween(point, group) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, count);
}

/** Groups within `radiusM` of the point, nearest first */
export function groupsWithin(point: LatLng, groups: AreaGroup[], radiusM: number): NearGroup[] {
  return nearestGroups(point, groups, groups.length).filter((group) => group.distanceM <= radiusM);
}

type Xy = [number, number];

const cross = (o: Xy, a: Xy, b: Xy) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeating the first point */
export function convexHull(points: Xy[]): Xy[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (sorted.length <= 2) return sorted;
  const lower: Xy[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Xy[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function segmentDistance(p: Xy, a: Xy, b: Xy): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance (in the plane's units) from a point to a convex hull (0 inside); a hull of 1 or 2 points is a point or segment */
export function distanceToHull(p: Xy, hull: Xy[]): number {
  if (hull.length === 0) return Infinity;
  if (hull.length === 1) return Math.hypot(p[0] - hull[0][0], p[1] - hull[0][1]);
  if (hull.length >= 3 && hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], p) >= 0)) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) best = Math.min(best, segmentDistance(p, hull[i], hull[(i + 1) % hull.length]));
  return best;
}

/** How far outside an area's group hull a point may lie and still count as inside (metres) */
export const HULL_BUFFER_M = 1000;

/**
 * Which area a point is probably in. Per area the convex hull of its groups (in RD metres) buffered by 1 km: inside
 * exactly one → that area (`hull`). Otherwise the area of the nearest group with an area (`nearest-group`). No group
 * has an area → `none`.
 */
export function estimateArea(point: LatLng, groups: AreaGroup[]): AreaEstimate {
  const withArea = groups.filter((group): group is AreaGroup & { area: string } => group.area !== null);
  if (withArea.length === 0) return { area: null, method: "none" };
  const rdOf = (latLng: LatLng): Xy => {
    const { x, y } = toRd(latLng.lng, latLng.lat);
    return [x, y];
  };
  const byArea = new Map<string, Xy[]>();
  for (const group of withArea) byArea.set(group.area, [...(byArea.get(group.area) ?? []), rdOf(group)]);
  const p = rdOf(point);
  const inside = [...byArea].filter(([, points]) => distanceToHull(p, convexHull(points)) <= HULL_BUFFER_M).map(([area]) => area);
  if (inside.length === 1) return { area: inside[0], method: "hull" };
  return { area: nearestGroups(point, withArea, 1)[0].area, method: "nearest-group" };
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npx --yes bun test src/services/intel-chat/geo.test.ts && npx --yes bun x tsc --noEmit`
Expected: 14 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/rd-answer.ts src/services/intel-chat/geo.ts src/services/intel-chat/geo.test.ts
git commit -m "feat(intel-chat): coordinate parsing, area estimate and nearest groups" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 3: Data loaders and point results (P1)

**Files:**
- Create: `src/services/intel-chat/data.ts`, `src/services/intel-chat/point.ts`
- Test: `src/services/intel-chat/point.test.ts`

**Interfaces:**
- Consumes: Task 2 geo helpers and types.
- Produces:
  - `loadGroups(): Promise<AreaGroup[]>` (all `Team`s, area via `knownAreaName`)
  - `SolvedHintPoint { articleId, articleTitle, area, slotTime: Date, lat, lng }`, `loadSolvedHintPoints(): Promise<SolvedHintPoint[]>` (solved RD cells of public hints, newest first)
  - `TrackerFix { name, source: "traccar" | "life360", lat, lng, at: Date }`, `loadTrackers(now: Date): Promise<TrackerFix[]>` (demo → simulated positions; Traccar when configured, failures → none; Life360 members from memory)
  - `PointResult`, `CheckPointResult` (contract shapes), `pointResult(parsed, label, groups): PointResult`, `CheckPointData { groups, hintPoints, trackers }`, `checkPointResult(parsed, { ...CheckPointData, label?, area?, articleId, now }): CheckPointResult`

Decisions: `otherHintPoints` leaves out the cells of the open item itself (they are the point being checked), keeps at most 10, `slotTime` is an ISO string. `pointResult` falls back to the 8-digit RD text when the label is empty.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/point.test.ts`

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { Team } from "../../models/team.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { setLife360Service, type Life360Service } from "../life360.service";
import { loadGroups, loadSolvedHintPoints, loadTrackers } from "./data";
import { parseCoordinate } from "./geo";
import { checkPointResult, pointResult } from "./point";

const NOW = new Date("2026-10-17T14:00:00Z");
const at = (rd: string) => {
  const { lat, lng } = parseCoordinate(rd)!.latLng;
  return { lat, lng };
};

function team(apiId: number, name: string, area: string | undefined, rd: string) {
  const { lat, lng } = at(rd);
  return { apiId, name, accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area, location: { type: "Point" as const, coordinates: [lng, lat] } };
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterEach(() => setLife360Service(null));
afterAll(disconnectTestDb);

describe("loaders", () => {
  test("loadGroups lowercases known areas and keeps unknown as null", async () => {
    await Team.create([team(1, "Groep A", "Alpha", "180000 440000"), team(2, "Groep B", undefined, "190000 440000"), team(3, "Groep Z", "Zulu", "200000 440000")]);
    const groups = (await loadGroups()).sort((a, b) => a.name.localeCompare(b.name));
    expect(groups.map((group) => [group.name, group.area])).toEqual([
      ["Groep A", "alpha"],
      ["Groep B", null],
      ["Groep Z", null],
    ]);
    expect(groups[0].lat).toBeCloseTo(at("180000 440000").lat, 6);
  });

  test("loadSolvedHintPoints: solved RD cells of public hints, newest first, with the article title", async () => {
    await Article.create([
      { id: 1, title: "Hint 1", type: "hint", publishAt: NOW, content: "x" },
      { id: 2, title: "Hint 2", type: "hint", publishAt: NOW, content: "x" },
    ]);
    const cell = (articleId: number, area: string, hour: number, extra: Record<string, unknown>) =>
      HintCell.create({ articleId, area, publishAt: NOW, slotTime: new Date(`2026-10-17T${hour}:00:00Z`), ...extra });
    await cell(1, "alpha", 10, { status: HintCellStatus.Solved, answer: "1800 4400", answerKind: "rd", answerLocation: [5.8, 51.9] });
    await cell(2, "alpha", 11, { status: HintCellStatus.Solved, answer: "1810 4400", answerKind: "rd", answerLocation: [5.81, 51.9] });
    await cell(2, "bravo", 11, { status: HintCellStatus.Solved, answer: "kaas", answerKind: "text" });
    await cell(2, "charlie", 11, { status: HintCellStatus.Open });
    await cell(900001, "alpha", 12, { status: HintCellStatus.Solved, answer: "1820 4400", answerKind: "rd", answerLocation: [5.82, 51.9] });
    const points = await loadSolvedHintPoints();
    expect(points.map((point) => [point.articleTitle, point.area, point.lng])).toEqual([
      ["Hint 2", "alpha", 5.81],
      ["Hint 1", "alpha", 5.8],
    ]);
  });

  test("loadTrackers: Life360 members with a fix (Traccar is not configured in tests)", async () => {
    setLife360Service({
      members: () => ({
        linked: true,
        stale: false,
        members: [
          { id: "a", name: "Anna B.", initials: "AB", avatarUrl: null, location: { lat: 51.9, lon: 5.9, accuracyM: 10, at: "2026-10-17T13:50:00Z", driving: false, speedKmh: null, battery: null, charging: false } },
          { id: "b", name: "Bob C.", initials: "BC", avatarUrl: null, location: null },
        ],
      }),
    } as unknown as Life360Service);
    expect(await loadTrackers(NOW)).toEqual([{ name: "Anna B.", source: "life360", lat: 51.9, lng: 5.9, at: new Date("2026-10-17T13:50:00Z") }]);
  });
});

describe("pointResult / checkPointResult", () => {
  const groups = [
    { name: "A1", area: "alpha", ...at("180000 440000") },
    { name: "A2", area: "alpha", ...at("182500 440000") },
    { name: "A3", area: "alpha", ...at("181000 442000") },
    { name: "B1", area: "bravo", ...at("200000 440000") },
  ];

  test("pointResult: rounded RD, 8-digit text, area estimate and nearest group; empty label falls back to the RD text", () => {
    const point = pointResult(parseCoordinate("181000 441000")!, "  ", groups);
    expect(point.rd).toEqual({ x: 181000, y: 441000 });
    expect(point.rdText).toBe("1810 4410");
    expect(point.label).toBe("1810 4410");
    expect(point.area).toEqual({ area: "alpha", method: "hull" });
    expect(point.nearestGroup?.name).toBe("A3");
  });

  test("checkPointResult: 5 nearest groups, other hint points of the area without the current item, nearest tracker with age", () => {
    const hint = (articleId: number, area: string, rd: string) => ({ articleId, articleTitle: `Hint ${articleId}`, area, slotTime: new Date("2026-10-17T12:00:00Z"), ...at(rd) });
    const result = checkPointResult(parseCoordinate("181000 441000")!, {
      groups,
      hintPoints: [hint(7, "alpha", "181000 442000"), hint(8, "alpha", "181000 441000"), hint(9, "bravo", "200000 440000")],
      trackers: [
        { name: "Auto 1", source: "traccar", ...at("181000 443500"), at: new Date("2026-10-17T13:45:00Z") },
        { name: "Fiets", source: "traccar", ...at("181000 441100"), at: new Date("2026-10-17T13:58:00Z") },
      ],
      articleId: 8,
      now: NOW,
    });
    expect(result.nearestGroups.map((group) => group.name)).toEqual(["A3", "A1", "A2", "B1"]);
    expect(result.insideNl).toBe(true);
    expect(result.otherHintPoints).toEqual([{ articleTitle: "Hint 7", slotTime: "2026-10-17T12:00:00.000Z", distanceM: expect.any(Number) }]);
    expect(Math.abs(result.otherHintPoints[0].distanceM - 1000)).toBeLessThan(15);
    expect(result.nearestTracker).toEqual({ name: "Fiets", distanceM: expect.any(Number), ageMin: 2 });
  });

  test("an explicit area wins over the estimate", () => {
    const result = checkPointResult(parseCoordinate("181000 440500")!, { groups, hintPoints: [{ articleId: 9, articleTitle: "Hint 9", area: "bravo", slotTime: NOW, ...at("200000 440000") }], trackers: [], area: "bravo", articleId: 1, now: NOW });
    expect(result.otherHintPoints).toHaveLength(1);
    expect(result.nearestTracker).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/point.test.ts`
Expected: FAIL (cannot find module `./data`).

- [ ] **Step 3: Implement** `src/services/intel-chat/data.ts`

```ts
import { knownAreaName } from "../../constants/areas";
import { isDemoMode } from "../../demo/demo-mode";
import { simulatedPositions } from "../../demo/simulated-trackers";
import { Article, publicArticlesFilter } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { Team } from "../../models/team.model";
import { getLife360Service } from "../life360.service";
import * as traccar from "../traccar.service";
import type { AreaGroup } from "./geo";

/** Every scouting group with its (lowercase) area, if known */
export async function loadGroups(): Promise<AreaGroup[]> {
  const teams = await Team.find({}, { _id: 0, name: 1, area: 1, location: 1 }).lean();
  return teams.map((team) => ({ name: team.name, area: knownAreaName(team.area), lng: team.location.coordinates[0], lat: team.location.coordinates[1] }));
}

export interface SolvedHintPoint {
  articleId: number;
  articleTitle: string;
  area: string;
  slotTime: Date;
  lat: number;
  lng: number;
}

/** Solved hint cells with a coordinate answer (public hint articles only), newest slot first */
export async function loadSolvedHintPoints(): Promise<SolvedHintPoint[]> {
  const cells = await HintCell.find(
    { status: HintCellStatus.Solved, answerKind: "rd", "answerLocation.1": { $exists: true }, articleId: publicArticlesFilter().id },
    { _id: 0, articleId: 1, area: 1, slotTime: 1, answerLocation: 1 },
  )
    .sort({ slotTime: -1 })
    .lean();
  const titles = new Map((await Article.find({ id: { $in: [...new Set(cells.map((cell) => cell.articleId))] } }, { _id: 0, id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));
  return cells.map((cell) => ({
    articleId: cell.articleId,
    articleTitle: titles.get(cell.articleId) ?? `Hint ${cell.articleId}`,
    area: cell.area,
    slotTime: cell.slotTime,
    lng: cell.answerLocation![0],
    lat: cell.answerLocation![1],
  }));
}

export interface TrackerFix {
  name: string;
  source: "traccar" | "life360";
  lat: number;
  lng: number;
  at: Date;
}

interface PositionLike {
  latitude: number;
  longitude: number;
  deviceName?: string;
  fixTime?: string | Date;
  deviceTime?: string | Date;
  serverTime?: string | Date;
}

/** Traccar positions (demo: the simulated hunters); none when Traccar is not configured or fails */
async function traccarFixes(now: Date): Promise<TrackerFix[]> {
  let positions: PositionLike[] = [];
  if (isDemoMode()) positions = simulatedPositions(now);
  else if (traccar.isTraccarConfigured) positions = ((await traccar.getPositions().catch(() => [])) as unknown as PositionLike[]) ?? [];
  return positions
    .filter((position) => Number.isFinite(position.latitude) && Number.isFinite(position.longitude))
    .map((position) => ({
      name: position.deviceName ?? "Tracker",
      source: "traccar" as const,
      lat: position.latitude,
      lng: position.longitude,
      at: new Date(position.fixTime ?? position.deviceTime ?? position.serverTime ?? now),
    }));
}

/** Life360 members with a fix (memory only, no request to Life360) */
function life360Fixes(): TrackerFix[] {
  const members = getLife360Service()?.members().members ?? [];
  return members.flatMap((member) =>
    member.location ? [{ name: member.name, source: "life360" as const, lat: member.location.lat, lng: member.location.lon, at: new Date(member.location.at) }] : [],
  );
}

/** Where our own hunters are: Traccar devices and Life360 members */
export async function loadTrackers(now: Date): Promise<TrackerFix[]> {
  return [...(await traccarFixes(now)), ...life360Fixes()];
}
```

- [ ] **Step 4: Implement** `src/services/intel-chat/point.ts`

```ts
import type { SolvedHintPoint, TrackerFix } from "./data";
import { estimateArea, formatCoordinate, insideNl, metresBetween, nearestGroups, type AreaEstimate, type AreaGroup, type LatLng, type NearGroup, type ParsedCoordinate, type Rd } from "./geo";

/** Output of showPoint, and the point of checkPoint / proposeHintAnswer (contract: PointResult) */
export interface PointResult {
  label: string;
  latLng: LatLng;
  rd: Rd;
  rdText: string;
  area: AreaEstimate;
  nearestGroup: NearGroup | null;
}

export interface CheckPointResult {
  point: PointResult;
  nearestGroups: NearGroup[];
  insideNl: boolean;
  otherHintPoints: { articleTitle: string; slotTime: string | null; distanceM: number }[];
  nearestTracker: { name: string; distanceM: number; ageMin: number } | null;
}

const MAX_LABEL = 80;

export function pointResult(parsed: ParsedCoordinate, label: string, groups: AreaGroup[]): PointResult {
  return {
    label: label.trim().slice(0, MAX_LABEL) || formatCoordinate(parsed).rd8,
    latLng: { lat: Number(parsed.latLng.lat.toFixed(6)), lng: Number(parsed.latLng.lng.toFixed(6)) },
    rd: { x: Math.round(parsed.rd.x), y: Math.round(parsed.rd.y) },
    rdText: formatCoordinate(parsed).rd8,
    area: estimateArea(parsed.latLng, groups),
    nearestGroup: nearestGroups(parsed.latLng, groups, 1)[0] ?? null,
  };
}

export interface CheckPointData {
  groups: AreaGroup[];
  hintPoints: SolvedHintPoint[];
  trackers: TrackerFix[];
}

/**
 * Everything worth knowing about a candidate point: area estimate, the 5 nearest groups, whether it is in the
 * Netherlands, distances to the other solved hint points of the area (`area`, else the estimated one; the current
 * item's own cells left out) and our nearest tracker.
 */
export function checkPointResult(parsed: ParsedCoordinate, options: CheckPointData & { label?: string; area?: string | null; articleId: number; now: Date }): CheckPointResult {
  const point = pointResult(parsed, options.label ?? "", options.groups);
  const area = options.area ?? point.area.area;
  const otherHintPoints = area
    ? options.hintPoints
        .filter((hint) => hint.area === area && hint.articleId !== options.articleId)
        .slice(0, 10)
        .map((hint) => ({ articleTitle: hint.articleTitle, slotTime: hint.slotTime ? hint.slotTime.toISOString() : null, distanceM: metresBetween(parsed.latLng, hint) }))
    : [];
  const trackers = options.trackers
    .map((tracker) => ({ name: tracker.name, distanceM: metresBetween(parsed.latLng, tracker), ageMin: Math.max(0, Math.round((options.now.getTime() - tracker.at.getTime()) / 60_000)) }))
    .sort((a, b) => a.distanceM - b.distanceM);
  return {
    point,
    nearestGroups: nearestGroups(parsed.latLng, options.groups, 5),
    insideNl: insideNl(parsed.latLng),
    otherHintPoints,
    nearestTracker: trackers[0] ?? null,
  };
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npx --yes bun test src/services/intel-chat/point.test.ts && npx --yes bun x tsc --noEmit`
Expected: 6 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/intel-chat/data.ts src/services/intel-chat/point.ts src/services/intel-chat/point.test.ts
git commit -m "feat(intel-chat): group, hint point and tracker loaders with point checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 4: Tool plumbing and app data tools (P1)

**Files:**
- Create: `src/services/intel-chat/tools/context.ts`, `src/services/intel-chat/tools/app-data.ts`, `src/test/tools.ts`
- Test: `src/services/intel-chat/tools/app-data.test.ts`

**Interfaces:**
- Consumes: `htmlToText`, `articleImages`, `articleAttachments`, `getHuntableAreas`, `groupConfig().homeTeamApiId`, `publicArticlesFilter`.
- Produces:
  - `IntelToolContext { articleId: number; now: () => Date; toolModel: LanguageModel; walkMinutes?: WalkMinutes; fetch?: (url, init) => Promise<Response>; lookup?: (hostname) => Promise<string[]> }` (the optional fields are used by Tasks 11-13; defined now so later tasks don't touch this file)
  - `ToolError { error: string }`, `class ToolInputError`, `safely<T>(toolName, run): Promise<T | ToolError>`
  - `ItemKind = "hint" | "opdracht" | "nieuws"`, `itemKind(type)`, `HintCellView`, `ItemView` (`articleId, title, kind, publishAt, endTime, maxPoints, summary, text, images, attachments, hintCells`), `cellView`, `itemView`, `findPublicArticle(articleId)`, `loadItemView(articleId): Promise<ItemView | null>`, `searchIntel(query, kind?)` → `{ results: { articleId, title, kind, publishAt, snippet }[] }`, `hintBoard(area?)` → `{ cells }`, `areasOverview()` → `{ ownArea, huntableConfigured, areas: { area, status, statusText, own, allowed, huntableNow, updatedAt }[] }`, `appDataTools(ctx)` → `{ getItem, searchIntel, getHintBoard, getAreas }`
  - `runTool(tool, input): Promise<unknown>` (tests)

Decisions: "huntbaar" is split into `allowed` (rule 5.1, the same rule as the client's `isForbiddenArea`: own area always, otherwise the admin list; everything while not configured) and `huntableNow` (`allowed` and status green/orange). Hidden test hints (id ≥ 900000) never show up in any tool.

- [ ] **Step 1: Create the test helper** `src/test/tools.ts`

```ts
import type { Tool } from "ai";

/** Run an AI SDK tool's execute the way streamText would (tests only) */
export async function runTool(tool: Tool, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("Tool has no execute");
  return await (tool.execute(input as never, { toolCallId: "test-call", messages: [], context: {} as never }) as Promise<unknown>);
}
```

- [ ] **Step 2: Write the failing test** `src/services/intel-chat/tools/app-data.test.ts`

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Area } from "../../../models/area.model";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { initHuntableAreas, resetHuntableAreas } from "../../../settings/huntable-areas-setting";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { appDataTools } from "./app-data";

const NOW = new Date("2026-10-17T14:00:00Z");
const tools = appDataTools({ articleId: 10, now: () => NOW, toolModel: mockModel(() => "") });

const HINT_HTML = `<div>Intro van de hint</div><div>Alpha: <img src="https://cdn.jotihunt.net/a.png" alt="alpha.png"></div><div>Bravo: -</div>`;

async function seed() {
  await Article.create([
    { id: 10, title: "De Highland Games", type: "hint", publishAt: new Date("2026-10-17T13:00:00Z"), content: HINT_HTML, summary: "Hint over spelen" },
    { id: 11, title: "Bouw een kasteel", type: "assignment", publishAt: new Date("2026-10-17T12:00:00Z"), content: "<p>Bouw een <b>kasteel</b> van karton</p>", maxPoints: 12, endTime: new Date("2026-10-17T18:00:00Z") },
    { id: 12, title: "Happy hour", type: "news", publishAt: new Date("2026-10-17T11:00:00Z"), content: "<p>Om 15:00 begint het happy hour met dubbele punten</p>" },
    { id: 900001, title: "Testhint kasteel", type: "hint", publishAt: NOW, content: "<p>kasteel</p>" },
  ]);
  const slotTime = new Date("2026-10-17T13:00:00Z");
  await HintCell.create([
    { articleId: 10, area: "bravo", publishAt: slotTime, slotTime, status: HintCellStatus.None },
    { articleId: 10, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "1884 4407", answerKind: "rd", answerLocation: [5.87, 51.95], snippet: "<div>Alpha: plaatje</div>" },
    { articleId: 10, area: "charlie", publishAt: slotTime, slotTime, status: HintCellStatus.Open },
    { articleId: 900001, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open },
  ]);
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seed();
});
afterEach(() => {
  resetHuntableAreas();
  delete process.env.HOME_TEAM_API_ID;
});
afterAll(disconnectTestDb);

describe("getItem", () => {
  test("the open item by default: text, kind, summary, images and hint cells in area order", async () => {
    const item = (await runTool(tools.getItem, {})) as Record<string, unknown> & { hintCells: { area: string; status: string; answer: string | null; location: unknown; snippet: string | null }[] };
    expect(item).toMatchObject({ articleId: 10, title: "De Highland Games", kind: "hint", summary: "Hint over spelen", images: [{ name: "alpha.png", url: "https://cdn.jotihunt.net/a.png" }], attachments: [] });
    expect(item.text).toBe("Intro van de hint\nAlpha: [afbeelding]\nBravo: -");
    expect(item.hintCells.map((cell) => [cell.area, cell.status, cell.answer])).toEqual([
      ["alpha", "solved", "1884 4407"],
      ["bravo", "none", null],
      ["charlie", "open", null],
    ]);
    expect(item.hintCells[0].location).toEqual({ lat: 51.95, lng: 5.87 });
    expect(item.hintCells[0].snippet).toBe("Alpha: plaatje");
  });

  test("another item by id; a hidden test hint or a missing id is an error", async () => {
    expect(await runTool(tools.getItem, { articleId: 11 })).toMatchObject({ kind: "opdracht", maxPoints: 12, endTime: "2026-10-17T18:00:00.000Z", hintCells: [] });
    expect(await runTool(tools.getItem, { articleId: 900001 })).toEqual({ error: "Item 900001 niet gevonden" });
    expect(await runTool(tools.getItem, { articleId: 5 })).toEqual({ error: "Item 5 niet gevonden" });
  });
});

describe("searchIntel", () => {
  test("case-insensitive in title and text, public items only, with a snippet", async () => {
    const { results } = (await runTool(tools.searchIntel, { query: "KASTEEL" })) as { results: { articleId: number; kind: string; snippet: string }[] };
    expect(results.map((result) => result.articleId)).toEqual([11]);
    expect(results[0]).toMatchObject({ kind: "opdracht", snippet: "Bouw een kasteel van karton" });
  });

  test("kind filter and a too short query", async () => {
    expect(((await runTool(tools.searchIntel, { query: "happy", kind: "hint" })) as { results: unknown[] }).results).toEqual([]);
    expect(((await runTool(tools.searchIntel, { query: "happy", kind: "nieuws" })) as { results: unknown[] }).results).toHaveLength(1);
    expect(await runTool(tools.searchIntel, { query: "a" })).toEqual({ error: "Zoekterm moet 2 tot 100 tekens zijn" });
  });

  test("regex characters are searched literally", async () => {
    expect(((await runTool(tools.searchIntel, { query: "(.*" })) as { results: unknown[] }).results).toEqual([]);
  });
});

describe("getHintBoard", () => {
  test("public cells with the article title; one area; unknown area is an error", async () => {
    const all = (await runTool(tools.getHintBoard, {})) as { cells: { articleTitle: string; area: string }[] };
    expect(all.cells).toHaveLength(3);
    expect(all.cells.every((cell) => cell.articleTitle === "De Highland Games")).toBe(true);
    const alpha = (await runTool(tools.getHintBoard, { area: "alpha" })) as { cells: { status: string; answer: string }[] };
    expect(alpha.cells).toEqual([expect.objectContaining({ status: "solved", answer: "1884 4407" })]);
    expect(await runTool(tools.getHintBoard, { area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
  });
});

describe("getAreas", () => {
  test("every area, status text, own area and the huntable setting", async () => {
    process.env.HOME_TEAM_API_ID = "7";
    await Team.create({ apiId: 7, name: "Onze groep", accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area: "Charlie", location: { type: "Point", coordinates: [5.9, 52] } });
    await Area.create([
      { name: "Alpha", status: "green", updatedAt: NOW },
      { name: "Bravo", status: "red", updatedAt: NOW },
      { name: "Charlie", status: "orange", updatedAt: NOW },
    ]);
    await initHuntableAreas({ readHuntableAreas: async () => ({ key: "huntable-areas", areas: ["bravo"], updatedAt: NOW, updatedBy: null }), writeHuntableAreas: async () => {} });
    const overview = (await runTool(tools.getAreas, {})) as { ownArea: string; huntableConfigured: boolean; areas: Record<string, unknown>[] };
    expect(overview.ownArea).toBe("charlie");
    expect(overview.huntableConfigured).toBe(true);
    expect(overview.areas).toHaveLength(9);
    const byArea = Object.fromEntries(overview.areas.map((area) => [area.area, area]));
    expect(byArea.alpha).toMatchObject({ status: "green", statusText: "actief", allowed: false, huntableNow: false, own: false });
    expect(byArea.bravo).toMatchObject({ status: "red", statusText: "inactief", allowed: true, huntableNow: false });
    expect(byArea.charlie).toMatchObject({ status: "orange", statusText: "onderweg", allowed: true, huntableNow: true, own: true });
    expect(byArea.oscar).toMatchObject({ status: "unknown", statusText: "onbekend", allowed: false, updatedAt: null });
  });

  test("not configured: every area allowed", async () => {
    await Area.create({ name: "Alpha", status: "green", updatedAt: NOW });
    const overview = (await runTool(tools.getAreas, {})) as { ownArea: null; huntableConfigured: boolean; areas: { area: string; huntableNow: boolean; allowed: boolean }[] };
    expect(overview.ownArea).toBeNull();
    expect(overview.huntableConfigured).toBe(false);
    expect(overview.areas.every((area) => area.allowed)).toBe(true);
    expect(overview.areas.find((area) => area.area === "alpha")?.huntableNow).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/tools/app-data.test.ts`
Expected: FAIL (cannot find module `./app-data`).

- [ ] **Step 4: Implement** `src/services/intel-chat/tools/context.ts`

```ts
import type { LanguageModel } from "ai";
import { logger } from "../../../logger";
import { GeminiError } from "../../ai/gemini-error";
import type { WalkMinutes } from "../../prediction/walking";

/** What every tool of one chat request may use */
export interface IntelToolContext {
  /** The item open in the Intel window */
  articleId: number;
  now: () => Date;
  /** Model for the webSearch and runCode sub-calls (Gemini built-in tools) */
  toolModel: LanguageModel;
  /** Walking minutes via ORS (distance tool); a straight-line estimate without it */
  walkMinutes?: WalkMinutes;
  /** HTTP for PDOK and readWebPage (tests pass a fake) */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** DNS lookup for readWebPage's address check (tests pass a fake) */
  lookup?: (hostname: string) => Promise<string[]>;
}

/** A tool's failure as the model sees it */
export interface ToolError {
  error: string;
}

/** A failure whose (Dutch) message may go to the model as is: bad input, nothing found, upstream refused */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Run a tool body; every failure becomes `{ error }` (never thrown into the stream). Only our own messages pass through;
 * anything unexpected is logged and reported as a generic error.
 */
export async function safely<T>(tool: string, run: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof GeminiError) return { error: error.message };
    logger.warn(`Intel chat tool ${tool} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { error: "Deze tool liep vast; probeer het anders" };
  }
}
```

- [ ] **Step 5: Implement** `src/services/intel-chat/tools/app-data.ts`

```ts
import { jsonSchema, tool } from "ai";
import { AREAS, knownAreaName, type AreaName } from "../../../constants/areas";
import { groupConfig } from "../../../auth/config";
import { Area } from "../../../models/area.model";
import { Article, publicArticlesFilter } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { getHuntableAreas } from "../../../settings/huntable-areas-setting";
import { articleAttachments, articleImages } from "../../article-media";
import { htmlToText } from "../../html-text";
import { safely, ToolInputError, type IntelToolContext } from "./context";

export type ItemKind = "hint" | "opdracht" | "nieuws";

const KIND_TYPES: Record<ItemKind, string> = { hint: "hint", opdracht: "assignment", nieuws: "news" };

export function itemKind(type: string): ItemKind {
  return type === "hint" ? "hint" : type === "assignment" ? "opdracht" : "nieuws";
}

export interface HintCellView {
  area: string;
  status: "open" | "solved" | "none";
  slotTime: string;
  answer: string | null;
  location: { lat: number; lng: number } | null;
  /** The part of the hint for this area (plain text), when the split found one */
  snippet: string | null;
}

export interface ItemView {
  articleId: number;
  title: string;
  kind: ItemKind;
  publishAt: string;
  endTime: string | null;
  maxPoints: number | null;
  summary: string | null;
  text: string;
  images: { name: string; url: string }[];
  attachments: string[];
  hintCells: HintCellView[];
}

const MAX_ITEM_TEXT = 12_000;
const MAX_SNIPPET = 1500;

interface ArticleLike {
  id: number;
  title: string;
  type: string;
  publishAt: Date;
  content: string;
  endTime?: Date | null;
  maxPoints?: number | null;
  summary?: string | null;
}

interface CellLike {
  area: string;
  status: string;
  slotTime: Date;
  answer?: string | null;
  answerLocation?: number[] | null;
  snippet?: string | null;
}

export function cellView(cell: CellLike): HintCellView {
  const status = cell.status === HintCellStatus.Solved ? "solved" : cell.status === HintCellStatus.None ? "none" : "open";
  const location = cell.answerLocation?.length === 2 ? { lng: cell.answerLocation[0], lat: cell.answerLocation[1] } : null;
  return {
    area: cell.area,
    status,
    slotTime: cell.slotTime.toISOString(),
    answer: status === "solved" ? (cell.answer ?? null) : null,
    location: status === "solved" ? location : null,
    snippet: cell.snippet ? htmlToText(cell.snippet).slice(0, MAX_SNIPPET) : null,
  };
}

export function itemView(article: ArticleLike, cells: CellLike[]): ItemView {
  return {
    articleId: article.id,
    title: article.title,
    kind: itemKind(article.type),
    publishAt: article.publishAt.toISOString(),
    endTime: article.endTime ? article.endTime.toISOString() : null,
    maxPoints: article.maxPoints ?? null,
    summary: article.summary || null,
    text: htmlToText(article.content).slice(0, MAX_ITEM_TEXT),
    images: articleImages(article.content).map(({ name, url }) => ({ name, url })),
    attachments: articleAttachments(article.content),
    hintCells: [...cells].sort((a, b) => AREAS.indexOf(a.area as AreaName) - AREAS.indexOf(b.area as AreaName)).map(cellView),
  };
}

/** A public article (not a seeded test hint), or null */
export function findPublicArticle(articleId: number) {
  return Article.findOne({ $and: [{ id: articleId }, publicArticlesFilter()] }).lean();
}

/** The item as the chat sees it, or null when it is not a public article */
export async function loadItemView(articleId: number): Promise<ItemView | null> {
  const article = await findPublicArticle(articleId);
  if (!article) return null;
  const cells = article.type === "hint" ? await HintCell.find({ articleId }).lean() : [];
  return itemView(article, cells);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Up to 10 public articles whose title or text contains the query, newest first, with a snippet around the match */
export async function searchIntel(query: string, kind?: ItemKind) {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) throw new ToolInputError("Zoekterm moet 2 tot 100 tekens zijn");
  const pattern = new RegExp(escapeRegExp(q), "i");
  const articles = await Article.find(
    { $and: [publicArticlesFilter(), { $or: [{ title: pattern }, { content: pattern }] }, ...(kind ? [{ type: KIND_TYPES[kind] }] : [])] },
    { _id: 0, id: 1, title: 1, type: 1, publishAt: 1, content: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(10)
    .lean();
  return {
    results: articles.map((article) => {
      const text = htmlToText(article.content);
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      const snippet = at < 0 ? text.slice(0, 160) : `${at > 80 ? "…" : ""}${text.slice(Math.max(0, at - 80), at + q.length + 80)}${at + q.length + 80 < text.length ? "…" : ""}`;
      return { articleId: article.id, title: article.title, kind: itemKind(article.type), publishAt: article.publishAt.toISOString(), snippet };
    }),
  };
}

/** Hint cells of public hints (one area or all), newest slot first, at most 150 */
export async function hintBoard(area?: string) {
  const key = area === undefined ? null : knownAreaName(area);
  if (area !== undefined && !key) throw new ToolInputError(`Onbekend deelgebied: ${area}`);
  const cells = await HintCell.find({ articleId: publicArticlesFilter().id, ...(key ? { area: key } : {}) })
    .sort({ slotTime: -1 })
    .limit(150)
    .lean();
  const titles = new Map((await Article.find({ id: { $in: [...new Set(cells.map((cell) => cell.articleId))] } }, { _id: 0, id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));
  return {
    cells: cells.map((cell) => {
      const { area: cellArea, status, slotTime, answer, location } = cellView(cell);
      return { articleId: cell.articleId, articleTitle: titles.get(cell.articleId) ?? `Hint ${cell.articleId}`, area: cellArea, slotTime, status, answer, location };
    }),
  };
}

const STATUS_TEXT: Record<string, string> = { green: "actief", orange: "onderweg", red: "inactief" };

/** Our own (hoofd) fox team: the area of the home team (HOME_TEAM_API_ID) */
async function ownArea(): Promise<AreaName | null> {
  const { homeTeamApiId } = groupConfig();
  if (!homeTeamApiId) return null;
  const team = await Team.findOne({ apiId: homeTeamApiId }, { _id: 0, area: 1 }).lean();
  return knownAreaName(team?.area);
}

/**
 * Every fox team with its status and whether we may hunt it (rule 5.1, same rule as the site's Vossen card: our own
 * area always; others when the admin allowed them; everything while not configured). `huntableNow` also needs
 * status green or orange.
 */
export async function areasOverview() {
  const [areas, own] = await Promise.all([Area.find({}, { _id: 0, name: 1, status: 1, updatedAt: 1 }).lean(), ownArea()]);
  const allowedList = getHuntableAreas();
  const byName = new Map(areas.map((area) => [knownAreaName(area.name), area]));
  return {
    ownArea: own,
    huntableConfigured: allowedList !== null,
    areas: AREAS.map((area) => {
      const doc = byName.get(area);
      const status = doc?.status ?? "unknown";
      const allowed = !allowedList || area === own || allowedList.includes(area);
      return {
        area,
        status,
        statusText: STATUS_TEXT[status] ?? "onbekend",
        own: area === own,
        allowed,
        huntableNow: allowed && (status === "green" || status === "orange"),
        updatedAt: doc?.updatedAt ? doc.updatedAt.toISOString() : null,
      };
    }),
  };
}

const KIND_VALUES: ItemKind[] = ["hint", "opdracht", "nieuws"];

export function appDataTools(ctx: IntelToolContext) {
  return {
    getItem: tool({
      description: "Lees een Intel-item: titel, soort, tekst, samenvatting, afbeeldingen, bijlagen en (bij een hint) de hintvakken per deelgebied met status en antwoord. Zonder articleId: het open item.",
      inputSchema: jsonSchema<{ articleId?: number }>({ type: "object", properties: { articleId: { type: "integer", description: "Id van een ander item; weglaten voor het open item" } } }),
      execute: ({ articleId }) =>
        safely("getItem", async () => {
          const item = await loadItemView(articleId ?? ctx.articleId);
          if (!item) throw new ToolInputError(`Item ${articleId ?? ctx.articleId} niet gevonden`);
          return item;
        }),
    }),
    searchIntel: tool({
      description: "Zoek in alle Intel-items (hints, opdrachten, nieuws) op een woord of zin in titel of tekst. Geeft de 10 nieuwste treffers met een stukje tekst.",
      inputSchema: jsonSchema<{ query: string; kind?: ItemKind }>({
        type: "object",
        properties: { query: { type: "string", description: "Zoekterm (2-100 tekens)" }, kind: { type: "string", enum: KIND_VALUES, description: "Alleen dit soort item" } },
        required: ["query"],
      }),
      execute: ({ query, kind }) => safely("searchIntel", () => searchIntel(query, kind)),
    }),
    getHintBoard: tool({
      description: "Het hintbord: per hint en deelgebied de status (open, solved, none = geen hint), het opgeslagen antwoord en de locatie daarvan. Optioneel één deelgebied.",
      inputSchema: jsonSchema<{ area?: string }>({ type: "object", properties: { area: { type: "string", enum: [...AREAS], description: "Alleen dit deelgebied" } } }),
      execute: ({ area }) => safely("getHintBoard", () => hintBoard(area)),
    }),
    getAreas: tool({
      description: "Alle vossenteams (deelgebieden) met status (green = actief, orange = onderweg, red = inactief), ons eigen vossenteam en of we ze mogen hunten.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: () => safely("getAreas", () => areasOverview()),
    }),
  };
}
```

- [ ] **Step 6: Run the test, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/tools/app-data.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 8 pass, 0 fail; tsc and eslint clean.

- [ ] **Step 7: Commit**

```bash
git add src/test/tools.ts src/services/intel-chat/tools/context.ts src/services/intel-chat/tools/app-data.ts src/services/intel-chat/tools/app-data.test.ts
git commit -m "feat(intel-chat): tool plumbing and app data tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 5: Map tools and proposals (P1)

**Files:**
- Create: `src/services/intel-chat/tools/map.ts`, `src/services/intel-chat/tools/proposals.ts`
- Test: `src/services/intel-chat/tools/map.test.ts`

**Interfaces:**
- Consumes: Task 2 geo, Task 3 loaders/point, Task 4 context and `findPublicArticle`.
- Produces:
  - `POINT_DESCRIPTION`, `readPoint(input, name = "point"): ParsedCoordinate` (throws `ToolInputError('Kon geen coördinaat lezen uit <name> "<input>"')`), `readArea(input?): string | undefined`
  - `mapTools(ctx)` → `{ convertCoordinates, checkPoint, nearbyGroups }`; outputs: `convertCoordinates` → `{ kind, rd, latLng, formatted: FormattedCoordinate, insideNl }`; `checkPoint` → `CheckPointResult`; `nearbyGroups` → `{ groups: NearGroup[] }` (radius clamped 50-20000 m, max 25)
  - `HintAnswerProposal` (contract), `normaliseAnswer(answer)` → `{ answer, kind, rd }`, `proposalTools(ctx)` → `{ showPoint, proposeHintAnswer }`

Decisions: every `point` argument is a string in any notation `parseCoordinate` reads (the model can pass RD straight from a hint). `proposeHintAnswer` keeps an answer `parseRdAnswer` reads exactly as typed (that is what `/solve` stores as a coordinate); another notation becomes the 8-digit RD answer; anything else is a word. It refuses when the open item is not a hint or has no cell for the area. The contract's `HintAnswerProposal.point` carries the area check and nearest group (the spec's `areaCheck`/`nearestGroup` fields), so there are no separate fields.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/tools/map.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { parseCoordinate } from "../geo";
import { mapTools } from "./map";
import { normaliseAnswer, proposalTools } from "./proposals";

const NOW = new Date("2026-10-17T14:00:00Z");
const ctx = { articleId: 10, now: () => NOW, toolModel: mockModel(() => "") };
const tools = { ...mapTools(ctx), ...proposalTools(ctx) };

function team(apiId: number, name: string, area: string, rd: string) {
  const { lat, lng } = parseCoordinate(rd)!.latLng;
  return { apiId, name, accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area, location: { type: "Point" as const, coordinates: [lng, lat] } };
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await Team.create([team(1, "A1", "Alpha", "180000 440000"), team(2, "A2", "Alpha", "182500 440000"), team(3, "A3", "Alpha", "181000 442000"), team(4, "B1", "Bravo", "200000 440000")]);
  await Article.create([
    { id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: "x" },
    { id: 11, title: "Nieuws", type: "news", publishAt: NOW, content: "x" },
  ]);
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open });
});
afterAll(disconnectTestDb);

describe("convertCoordinates", () => {
  test("RD in, every notation out", async () => {
    expect(await runTool(tools.convertCoordinates, { input: "188362 440722" })).toMatchObject({ kind: "rd", rd: { x: 188362, y: 440722 }, formatted: { rd8: "1884 4407", rdFull: "188362 440722" }, insideNl: true });
  });

  test("unreadable input is an error the model can read", async () => {
    expect(await runTool(tools.convertCoordinates, { input: "geen idee" })).toEqual({ error: 'Kon geen coördinaat lezen uit input "geen idee"' });
  });
});

describe("checkPoint", () => {
  test("area estimate, nearest groups and no trackers in tests", async () => {
    const result = (await runTool(tools.checkPoint, { point: "181000 441000" })) as { point: { area: unknown; rdText: string }; nearestGroups: { name: string }[]; nearestTracker: unknown; insideNl: boolean };
    expect(result.point).toMatchObject({ rdText: "1810 4410", area: { area: "alpha", method: "hull" } });
    expect(result.nearestGroups.map((group) => group.name)).toEqual(["A3", "A1", "A2", "B1"]);
    expect(result.nearestTracker).toBeNull();
    expect(result.insideNl).toBe(true);
  });

  test("an unknown area is an error", async () => {
    expect(await runTool(tools.checkPoint, { point: "181000 441000", area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
  });
});

describe("nearbyGroups", () => {
  test("within the radius, clamped to 50..20000 m", async () => {
    const near = (await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 1500 })) as { groups: { name: string }[] };
    expect(near).toEqual({ groups: [expect.objectContaining({ name: "A3", area: "alpha" }), expect.objectContaining({ name: "A1" })] });
    const wide = (await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 999_999 })) as { groups: { name: string }[] };
    expect(wide.groups).toHaveLength(4);
    expect(((await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 1 })) as { groups: unknown[] }).groups).toEqual([]);
  });
});

describe("showPoint", () => {
  test("a PointResult with the label", async () => {
    expect(await runTool(tools.showPoint, { point: "51.95392, 5.87252", label: "HQ" })).toMatchObject({ label: "HQ", rdText: "1884 4407", latLng: { lat: 51.95392, lng: 5.87252 } });
  });
});

describe("proposeHintAnswer", () => {
  test("an 8-digit RD answer stays as typed and gets a point", async () => {
    const proposal = (await runTool(tools.proposeHintAnswer, { area: "Alpha", answer: " 1810 4410 " })) as Record<string, unknown> & { point: { rdText: string; label: string } };
    expect(proposal).toMatchObject({ articleId: 10, area: "alpha", answer: "1810 4410", kind: "rd" });
    expect(proposal.point).toMatchObject({ rdText: "1810 4410", label: "Alpha: 1810 4410" });
  });

  test("another notation becomes the 8-digit RD answer; a word stays text", async () => {
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "51.95392, 5.87252" })).toMatchObject({ answer: "1884 4407", kind: "rd" });
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "Doedelzak" })).toMatchObject({ answer: "Doedelzak", kind: "text", point: null });
  });

  test("errors: unknown area, area without a cell, item not a hint, empty answer", async () => {
    expect(await runTool(tools.proposeHintAnswer, { area: "zulu", answer: "x" })).toEqual({ error: "Onbekend deelgebied: zulu" });
    expect(await runTool(tools.proposeHintAnswer, { area: "bravo", answer: "x" })).toEqual({ error: "Deze hint heeft geen vak voor Bravo" });
    expect(await runTool(proposalTools({ ...ctx, articleId: 11 }).proposeHintAnswer, { area: "alpha", answer: "x" })).toEqual({ error: "Het open item is geen hint" });
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "  " })).toEqual({ error: "Antwoord moet 1 tot 200 tekens zijn" });
  });

  test("normaliseAnswer keeps 6+6 RD as typed (parseRdAnswer reads it)", () => {
    expect(normaliseAnswer("188362 440722")).toMatchObject({ answer: "188362 440722", kind: "rd" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/tools/map.test.ts`
Expected: FAIL (cannot find module `./map`).

- [ ] **Step 3: Implement** `src/services/intel-chat/tools/map.ts`

```ts
import { jsonSchema, tool } from "ai";
import { AREAS, knownAreaName } from "../../../constants/areas";
import { loadGroups, loadSolvedHintPoints, loadTrackers } from "../data";
import { formatCoordinate, groupsWithin, insideNl, parseCoordinate, type ParsedCoordinate } from "../geo";
import { checkPointResult } from "../point";
import { safely, ToolInputError, type IntelToolContext } from "./context";

/** Description of a `point` argument, shared by every tool that takes one */
export const POINT_DESCRIPTION = 'Coördinaat als tekst: RD ("1884 4407" of "188362 440722"), decimaal ("51.95392, 5.87252") of graden-minuten ("N 51° 57.235 E 5° 52.351")';

/** The point, or a ToolInputError the model can act on */
export function readPoint(input: string, name = "point"): ParsedCoordinate {
  const parsed = parseCoordinate(String(input ?? ""));
  if (!parsed) throw new ToolInputError(`Kon geen coördinaat lezen uit ${name} "${String(input ?? "").slice(0, 60)}"`);
  return parsed;
}

/** A known area (lowercase), undefined when not given; ToolInputError when unknown */
export function readArea(input: string | undefined): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const area = knownAreaName(input);
  if (!area) throw new ToolInputError(`Onbekend deelgebied: ${input}`);
  return area;
}

const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 20_000;
const MAX_NEARBY = 25;
export function mapTools(ctx: IntelToolContext) {
  return {
    convertCoordinates: tool({
      description: "Zet een coördinaat om (RD in 4/5/6 cijfers, decimale graden of graden-minuten-seconden). Geeft RD, lat/lng en alle notaties, waaronder het 8-cijferige Jotihunt-antwoord (rd8).",
      inputSchema: jsonSchema<{ input: string }>({ type: "object", properties: { input: { type: "string", description: "De coördinaat zoals gevonden" } }, required: ["input"] }),
      execute: ({ input }) =>
        safely("convertCoordinates", async () => {
          const parsed = readPoint(input, "input");
          return { kind: parsed.kind, rd: { x: Math.round(parsed.rd.x), y: Math.round(parsed.rd.y) }, latLng: parsed.latLng, formatted: formatCoordinate(parsed), insideNl: insideNl(parsed.latLng) };
        }),
    }),
    checkPoint: tool({
      description:
        "Controleer een kandidaat-punt: geschat deelgebied (method 'hull' = zeker, anders een schatting), de 5 dichtstbijzijnde groepen, of het in Nederland ligt, afstand tot de andere opgeloste hintpunten van dat deelgebied en onze dichtstbijzijnde tracker. Altijd gebruiken voor je een punt voorstelt.",
      inputSchema: jsonSchema<{ point: string; area?: string }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, area: { type: "string", enum: [...AREAS], description: "Deelgebied waar het punt bij hoort, als je dat weet" } },
        required: ["point"],
      }),
      execute: ({ point, area }) =>
        safely("checkPoint", async () => {
          const parsed = readPoint(point);
          const key = readArea(area);
          const now = ctx.now();
          const [groups, hintPoints, trackers] = await Promise.all([loadGroups(), loadSolvedHintPoints(), loadTrackers(now)]);
          return checkPointResult(parsed, { groups, hintPoints, trackers, area: key, articleId: ctx.articleId, now });
        }),
    }),
    nearbyGroups: tool({
      description: "Scoutinggroepen binnen een straal rond een punt, dichtstbijzijnde eerst (max 25).",
      inputSchema: jsonSchema<{ point: string; radiusM: number }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, radiusM: { type: "number", description: "Straal in meters (50-20000)" } },
        required: ["point", "radiusM"],
      }),
      execute: ({ point, radiusM }) =>
        safely("nearbyGroups", async () => {
          const parsed = readPoint(point);
          const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Number(radiusM) || 0));
          return { groups: groupsWithin(parsed.latLng, await loadGroups(), radius).slice(0, MAX_NEARBY) };
        }),
    }),
  };
}
```

- [ ] **Step 4: Implement** `src/services/intel-chat/tools/proposals.ts`

```ts
import { jsonSchema, tool } from "ai";
import { AREAS, areaTitle, knownAreaName } from "../../../constants/areas";
import { HintCell } from "../../../models/hint-cell.model";
import { formatRdAnswer, parseRdAnswer } from "../../rd-answer";
import { loadGroups } from "../data";
import { parseCoordinate } from "../geo";
import { pointResult, type PointResult } from "../point";
import { findPublicArticle } from "./app-data";
import { safely, ToolInputError, type IntelToolContext } from "./context";
import { POINT_DESCRIPTION, readPoint } from "./map";

/** proposeHintAnswer output (contract: HintAnswerProposal) */
export interface HintAnswerProposal {
  articleId: number;
  area: string;
  answer: string;
  kind: "rd" | "text";
  point: PointResult | null;
}

const MAX_ANSWER = 200;

/**
 * The answer as "Zet als antwoord" will post it. An answer parseRdAnswer reads (what POST /hints/.../solve stores as a
 * coordinate) stays as typed; another coordinate notation becomes the 8-digit RD answer; anything else is a word.
 */
export function normaliseAnswer(answer: string): { answer: string; kind: "rd" | "text"; rd: ReturnType<typeof parseRdAnswer> } {
  const trimmed = String(answer ?? "").trim();
  if (!trimmed || trimmed.length > MAX_ANSWER) throw new ToolInputError("Antwoord moet 1 tot 200 tekens zijn");
  const rd = parseRdAnswer(trimmed);
  if (rd) return { answer: trimmed, kind: "rd", rd };
  const parsed = parseCoordinate(trimmed);
  if (parsed) {
    const asRd = formatRdAnswer(parsed.latLng.lng, parsed.latLng.lat);
    return { answer: asRd, kind: "rd", rd: parseRdAnswer(asRd) };
  }
  return { answer: trimmed, kind: "text", rd: null };
}

export function proposalTools(ctx: IntelToolContext) {
  return {
    showPoint: tool({
      description: "Zet een punt klaar als kaart-kaartje voor de gebruiker (met knop 'Toon op kaart'). Gebruik dit om een gevonden of berekend punt te laten zien. Slaat niets op.",
      inputSchema: jsonSchema<{ point: string; label: string }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, label: { type: "string", description: "Korte naam voor het punt (max 80 tekens)" } },
        required: ["point", "label"],
      }),
      execute: ({ point, label }) => safely("showPoint", async () => pointResult(readPoint(point), String(label ?? ""), await loadGroups())),
    }),
    proposeHintAnswer: tool({
      description:
        "Stel een antwoord voor op een hintvak van het open hint-item. De gebruiker ziet een kaartje met de knop 'Zet als antwoord'; alleen die klik slaat het op. Een coördinaat wordt het 8-cijferige RD-antwoord, tenzij je al RD gaf.",
      inputSchema: jsonSchema<{ area: string; answer: string }>({
        type: "object",
        properties: { area: { type: "string", enum: [...AREAS], description: "Deelgebied van het hintvak" }, answer: { type: "string", description: "Het antwoord: RD-coördinaat of woord" } },
        required: ["area", "answer"],
      }),
      execute: ({ area, answer }) =>
        safely("proposeHintAnswer", async (): Promise<HintAnswerProposal> => {
          const key = knownAreaName(area);
          if (!key) throw new ToolInputError(`Onbekend deelgebied: ${area}`);
          const article = await findPublicArticle(ctx.articleId);
          if (!article || article.type !== "hint") throw new ToolInputError("Het open item is geen hint");
          if (!(await HintCell.exists({ articleId: ctx.articleId, area: key }))) throw new ToolInputError(`Deze hint heeft geen vak voor ${areaTitle(key)}`);
          const normalised = normaliseAnswer(answer);
          const point = normalised.rd ? pointResult({ kind: "rd", rd: { x: normalised.rd.x, y: normalised.rd.y }, latLng: { lat: normalised.rd.lat, lng: normalised.rd.lng } }, `${areaTitle(key)}: ${normalised.answer}`, await loadGroups()) : null;
          return { articleId: ctx.articleId, area: key, answer: normalised.answer, kind: normalised.kind, point };
        }),
    }),
  };
}
```

- [ ] **Step 5: Run the test, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/tools/map.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 10 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/intel-chat/tools/map.ts src/services/intel-chat/tools/proposals.ts src/services/intel-chat/tools/map.test.ts
git commit -m "feat(intel-chat): coordinate, point check and answer proposal tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 6: webSearch (P1)

**Files:**
- Create: `src/services/intel-chat/tools/web.ts`
- Test: `src/services/intel-chat/tools/web.test.ts`

**Interfaces:**
- Consumes: `ctx.toolModel`, `toGeminiError`, `localGoogle` from `src/test/ai.ts`.
- Produces: `WEB_TOOL_NAMES = ["webSearch", "readWebPage"] as const`, `WebSearchResult { answer, sources: { title, url }[] }`, `webSearch(model, query, abortSignal?)`, `webTools(ctx)` → `{ webSearch }` (Task 13 adds `readWebPage`).

Verified against ai 7.0.127 / @ai-sdk/google 4.0.87: `generateText` with `tools: { google_search: google.tools.googleSearch({}) }` sends `tools: [{ googleSearch: {} }]`, and grounding chunks come back as `result.sources` (`sourceType: "url"`, `url`, `title`). The tool factory needs no API key (`import { google } from "@ai-sdk/google"`); the call uses the server's model.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/tools/web.test.ts`

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { localGoogle } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { webTools } from "./web";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function fakeGemini(respond: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const google = localGoogle(async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    bodies.push(body);
    return respond(body);
  });
  stop = google.stop;
  return { tools: webTools({ articleId: 1, now: () => new Date(), toolModel: google.model("gemini-test") }), bodies };
}

const grounded = (text: string, chunks: { uri: string; title?: string }[]) =>
  Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["q"], groundingChunks: chunks.map((web) => ({ web })) } }] });

describe("webSearch", () => {
  test("asks Gemini with Google Search grounding and returns the answer with sources once per URL", async () => {
    const { tools, bodies } = fakeGemini(() =>
      grounded(" Merida is de prinses uit Brave. ", [
        { uri: "https://example.org/brave", title: "example.org" },
        { uri: "https://example.org/brave", title: "example.org" },
        { uri: "https://wiki.example/merida" },
      ]),
    );
    const result = await runTool(tools.webSearch, { query: "wie is Merida" });
    expect(result).toEqual({
      answer: "Merida is de prinses uit Brave.",
      sources: [
        { title: "example.org", url: "https://example.org/brave" },
        { title: "wiki.example", url: "https://wiki.example/merida" },
      ],
    });
    expect(bodies[0].tools).toEqual([{ googleSearch: {} }]);
    expect(JSON.stringify(bodies[0].contents)).toContain("wie is Merida");
  });

  test("a Gemini failure becomes { error } with our Dutch message", async () => {
    const { tools } = fakeGemini(() => Response.json({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }, { status: 503 }));
    expect(await runTool(tools.webSearch, { query: "x" })).toEqual({ error: "Gemini-verzoek mislukt (HTTP 503)" });
  });

  test("an empty query is refused without calling Gemini", async () => {
    const { tools, bodies } = fakeGemini(() => grounded("x", []));
    expect(await runTool(tools.webSearch, { query: "  " })).toEqual({ error: "Zoekvraag moet 1 tot 300 tekens zijn" });
    expect(bodies).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/tools/web.test.ts`
Expected: FAIL (cannot find module `./web`).

- [ ] **Step 3: Implement** `src/services/intel-chat/tools/web.ts`

```ts
import { google } from "@ai-sdk/google";
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { toGeminiError } from "../../ai/gemini-error";
import { safely, ToolInputError, type IntelToolContext } from "./context";

/** Tools that reach the internet; only active when the user switched "Web" on */
export const WEB_TOOL_NAMES = ["webSearch", "readWebPage"] as const;

export interface WebSearchResult {
  answer: string;
  sources: { title: string; url: string }[];
}

/** One Google-grounded sub-call; the answer is short, it goes back into the chat's own model */
export const WEB_SEARCH_TIMEOUT_MS = 30_000;
const MAX_SOURCES = 8;
const MAX_ANSWER_CHARS = 4000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * Search the web with Gemini's Google Search grounding (its own call: built-in tools are not mixed with our function
 * tools). Sources come from the grounding metadata, once per URL.
 */
export async function webSearch(model: LanguageModel, query: string, abortSignal?: AbortSignal): Promise<WebSearchResult> {
  const q = String(query ?? "").trim();
  if (!q || q.length > 300) throw new ToolInputError("Zoekvraag moet 1 tot 300 tekens zijn");
  try {
    const result = await generateText({
      model,
      instructions: "Zoek dit op met Google Search en antwoord kort en feitelijk in het Nederlands (max 8 zinnen). Noem concrete getallen, namen en plaatsen. Verzin niets.",
      prompt: q,
      tools: { google_search: google.tools.googleSearch({}) },
      maxRetries: 0,
      timeout: WEB_SEARCH_TIMEOUT_MS,
      abortSignal,
    });
    const sources: WebSearchResult["sources"] = [];
    for (const source of result.sources) {
      if (source.sourceType !== "url" || sources.some((known) => known.url === source.url)) continue;
      sources.push({ title: source.title?.trim() || hostOf(source.url), url: source.url });
      if (sources.length >= MAX_SOURCES) break;
    }
    return { answer: result.text.trim().slice(0, MAX_ANSWER_CHARS), sources };
  } catch (error) {
    throw toGeminiError(error);
  }
}

export function webTools(ctx: IntelToolContext) {
  return {
    webSearch: tool({
      description: "Zoek op internet (Google). Voor feiten, plaatsen, namen, trivia en codes die je niet zeker weet. Geeft een kort antwoord met bronnen.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Zoekvraag, zo specifiek mogelijk" } }, required: ["query"] }),
      execute: ({ query }, { abortSignal }) => safely("webSearch", () => webSearch(ctx.toolModel, query, abortSignal)),
    }),
  };
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx --yes bun test src/services/intel-chat/tools/web.test.ts && npx --yes bun x tsc --noEmit`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/intel-chat/tools/web.ts src/services/intel-chat/tools/web.test.ts
git commit -m "feat(intel-chat): webSearch via a Google Search grounded sub-call" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 7: System prompt, message rules, item images (P1)

**Files:**
- Create: `src/services/intel-chat/prompt.ts`, `src/services/intel-chat/messages.ts`, `src/services/intel-chat/item-images.ts`
- Test: `src/services/intel-chat/messages.test.ts`

**Interfaces:**
- Consumes: `ItemView` (Task 4), `fetchImages` / `articleImages` / `FetchedImage` from `article-media.ts`.
- Produces:
  - `dutchDateTime(date)`, `GAME_RULES`, `buildSystemPrompt({ item, now, web, attachedImages }): string`
  - `MAX_HISTORY_TO_MODEL = 40`, `MAX_STORED_MESSAGES = 200`, `MAX_USER_IMAGES = 2`, `MAX_USER_IMAGE_BYTES`, `USER_IMAGE_TYPES`, `MAX_USER_TEXT = 4000`, `DROPPED_IMAGE_TEXT`; `parseIncomingMessage(value): UIMessage | null`, `appendMessage(history, message)`, `forStorage(messages)`, `modelWindow(messages)`, `withItemImages(modelMessages, images)`
  - `ITEM_IMAGE_CACHE_MS`, `clearItemImageCache()`, `loadItemImages(article, download?, now?): Promise<FetchedImage[]>`

Decisions:
- "Item images on the first user turn only" = the images go into the first user message of the model window on every turn (so the model always sees them once, however long the chat). Downloads are cached per article content for 10 minutes (3 items).
- User images: only the newest 2 are kept (stored and sent); older file parts become the text part `DROPPED_IMAGE_TEXT`. This keeps a chat document far under MongoDB's 16 MB and a Gemini request under ~20 MB (14 MB item images + 2 × 2 MB). Stored history may therefore contain user messages with two text parts.
- `appendMessage` implements the "Opnieuw" rule: a known id truncates history at that message.
- Streaming text left by an abort is stored with `state: "done"`; assistant messages without content are dropped.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/messages.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import { clearItemImageCache, loadItemImages } from "./item-images";
import { appendMessage, DROPPED_IMAGE_TEXT, forStorage, MAX_HISTORY_TO_MODEL, modelWindow, parseIncomingMessage, withItemImages } from "./messages";
import { buildSystemPrompt, dutchDateTime } from "./prompt";
import type { ItemView } from "./tools/app-data";

const png = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
const user = (id: string, text = "vraag", extra: UIMessage["parts"] = []): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }, ...extra] });
const assistant = (id: string, text = "antwoord"): UIMessage => ({ id, role: "assistant", parts: [{ type: "step-start" }, { type: "text", text, state: "done" }] });

describe("parseIncomingMessage", () => {
  test("a text message, trimmed; with one image", () => {
    expect(parseIncomingMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "  Los Alpha op  " }] })).toEqual(user("m1", "Los Alpha op"));
    const withImage = parseIncomingMessage({ id: "m2", role: "user", parts: [{ type: "text", text: "kijk" }, { type: "file", mediaType: "image/png", url: png(100), filename: "foto.png" }] });
    expect(withImage?.parts[1]).toEqual({ type: "file", mediaType: "image/png", url: png(100), filename: "foto.png" });
  });

  test("refuses everything outside the contract", () => {
    const bad: unknown[] = [
      null,
      "hoi",
      { id: "m", role: "assistant", parts: [{ type: "text", text: "x" }] },
      { id: "", role: "user", parts: [{ type: "text", text: "x" }] },
      { id: "m", role: "user", parts: [] },
      { id: "m", role: "user", parts: [{ type: "text", text: "   " }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(4001) }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "tool-getItem", toolCallId: "x" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/gif", url: "data:image/gif;base64,AAAA" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: "https://example.org/a.png" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(2 * 1024 * 1024 + 1) }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(10) }, { type: "file", mediaType: "image/png", url: png(10) }] },
    ];
    for (const value of bad) expect(parseIncomingMessage(value)).toBeNull();
  });

  test("an image of exactly 2 MB is fine", () => {
    expect(parseIncomingMessage({ id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(2 * 1024 * 1024) }] })).not.toBeNull();
  });
});

describe("appendMessage", () => {
  test("appends; a known id replaces it and what came after (retry)", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    expect(appendMessage(history, user("u3")).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(appendMessage(history, user("u2", "opnieuw")).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });
});

describe("forStorage", () => {
  test("keeps only the newest 2 user images, finishes streaming text and drops empty assistant messages", () => {
    const image = (n: number) => ({ type: "file" as const, mediaType: "image/png", url: png(n) });
    const messages: UIMessage[] = [
      user("u1", "a", [image(1)]),
      user("u2", "b", [image(2)]),
      user("u3", "c", [image(3)]),
      { id: "a3", role: "assistant", parts: [{ type: "step-start" }] },
      { id: "a4", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "half", state: "streaming" }] },
    ];
    const stored = forStorage(messages);
    expect(stored.map((m) => m.id)).toEqual(["u1", "u2", "u3", "a4"]);
    expect(stored[0].parts[1]).toEqual({ type: "text", text: DROPPED_IMAGE_TEXT });
    expect(stored[1].parts[1]).toEqual(image(2));
    expect(stored[2].parts[1]).toEqual(image(3));
    expect(stored[3].parts[1]).toEqual({ type: "text", text: "half", state: "done" });
  });
});

describe("modelWindow", () => {
  test("the newest 40, starting at a user message", () => {
    const messages = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`)));
    const window = modelWindow(messages);
    expect(window.length).toBeLessThanOrEqual(MAX_HISTORY_TO_MODEL);
    expect(window[0].role).toBe("user");
    expect(window.at(-1)?.id).toBe("a49");
  });
});

describe("withItemImages", () => {
  test("puts the item images in front of the first user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "eerste" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "tweede" }] },
    ];
    const result = withItemImages(messages, [{ name: "kaart.png", mediaType: "image/png", data: new Uint8Array([1, 2]) }]);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Afbeeldingen van het open item: kaart.png" },
        { type: "file", data: new Uint8Array([1, 2]), mediaType: "image/png", filename: "kaart.png" },
        { type: "text", text: "eerste" },
      ],
    });
    expect(result[2]).toBe(messages[2]);
    expect(withItemImages(messages, [])).toBe(messages);
  });
});

describe("loadItemImages", () => {
  const article = { id: 1, contentHash: "h1", content: '<img src="https://cdn.jotihunt.net/a.png" alt="a.png">' };

  test("downloads once per article content within 10 minutes; never throws", async () => {
    clearItemImageCache();
    let calls = 0;
    const download = async () => {
      calls++;
      return [{ name: "a.png", mediaType: "image/png", data: new Uint8Array([1]) }];
    };
    expect(await loadItemImages(article, download, 0)).toHaveLength(1);
    await loadItemImages(article, download, 60_000);
    expect(calls).toBe(1);
    await loadItemImages(article, download, 11 * 60_000);
    expect(calls).toBe(2);
    expect(await loadItemImages({ ...article, contentHash: "h2" }, async () => Promise.reject(new Error("down")), 0)).toEqual([]);
    expect(await loadItemImages({ id: 2, content: "<p>geen plaatjes</p>" }, download, 0)).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  const item: ItemView = {
    articleId: 10,
    title: "De Highland Games",
    kind: "hint",
    publishAt: "2026-10-17T12:00:00.000Z",
    endTime: null,
    maxPoints: null,
    summary: "Een hint over spelen",
    text: "Intro\nAlpha: [afbeelding]\nBravo: -",
    images: [
      { name: "alpha.png", url: "https://cdn.jotihunt.net/a.png" },
      { name: "extern.png", url: "https://example.org/x.png" },
    ],
    attachments: ["puzzel.zip"],
    hintCells: [
      { area: "alpha", status: "solved", slotTime: "2026-10-17T12:00:00.000Z", answer: "1884 4407", location: { lat: 51.95, lng: 5.87 }, snippet: "Alpha: plaatje" },
      { area: "bravo", status: "none", slotTime: "2026-10-17T12:00:00.000Z", answer: null, location: null, snippet: null },
    ],
  };
  const now = new Date("2026-10-17T12:05:00Z");

  test("rules, Dutch time, the item with its cells and images", () => {
    const prompt = buildSystemPrompt({ item, now, web: true, attachedImages: ["alpha.png"] });
    expect(dutchDateTime(now)).toBe("zaterdag 17 oktober 14:05");
    expect(prompt).toContain("zaterdag 17 oktober 14:05");
    expect(prompt).toContain("Titel: De Highland Games");
    expect(prompt).toContain('- Alpha: opgelost, antwoord "1884 4407" | deel: Alpha: plaatje');
    expect(prompt).toContain("- Bravo: geen hint");
    expect(prompt).toContain("in deze volgorde bijgevoegd bij het eerste bericht: alpha.png");
    expect(prompt).toContain("Afbeeldingen die je niet kunt zien: extern.png");
    expect(prompt).toContain("Bijlagen (niet leesbaar voor jou): puzzel.zip");
    expect(prompt).toContain("1884 4407");
    expect(prompt).toContain("webSearch");
    expect(prompt).toContain("checkPoint");
  });

  test("web off tells the model to suggest switching Web on", () => {
    const prompt = buildSystemPrompt({ item, now, web: false, attachedImages: [] });
    expect(prompt).toContain('Internet staat uit');
    expect(prompt).not.toContain("gebruik webSearch");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/messages.test.ts`
Expected: FAIL (cannot find module `./item-images`).

- [ ] **Step 3: Implement** `src/services/intel-chat/prompt.ts`

```ts
import { areaTitle, type AreaName } from "../../constants/areas";
import type { ItemView } from "./tools/app-data";

const KIND_LABEL = { hint: "hint", opdracht: "opdracht", nieuws: "nieuwsbericht" } as const;

/** "zaterdag 17 oktober 14:05" in Dutch time */
export function dutchDateTime(date: Date): string {
  const day = date.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Amsterdam" });
  const time = date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return `${day} ${time}`;
}

/** The Jotihunt rules the assistant needs, distilled from docs/02-game-rules.md and docs/04-hints-and-puzzles.md */
export const GAME_RULES = `## Het spel in het kort
- Jotihunt 2026: za 17 okt 10:00 tot zo 18 okt 12:00, in Gelderland. Thema: BRAVE (Pixar) en Schotland. HQ Jotihunt: Stikkerstraat 10, Arnhem (RD 188362 440722).
- Negen vossenteams (deelgebieden): Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel en Oscar. Vossen lopen te voet (ongeveer 4-5 km/u) langs de scoutinggroepen van hun deelgebied; Oscar reist waarschijnlijk met het OV.
- Status van een vos: groen = actief (huntbaar), oranje = onderweg (nog huntbaar), rood = inactief (niet huntbaar). Rond 23:00 wisselen de teams (22:45-23:15 inactief).
- Hunt: fysiek contact met de vossen, huntcode binnen 30 minuten invoeren met tijd en foto. Daarna 1 uur dezelfde vos niet hunten. Ons eigen (hoofd)vossenteam: 6 punten, andere toegestane vossen: 3, niet toegestane vossen: 0.
- Hints: elk uur een hint met een gezamenlijke intro en per deelgebied een gecodeerd deel. "-" of "--" betekent geen hint voor dat deelgebied dit uur. Een volledig goed antwoord binnen 20 minuten = 1 punt per vossenteam; foute antwoorden worden niet verbeterd.
- Het antwoord is meestal een RD-coördinaat (Rijksdriehoek, meters) in 8 cijfers "XXXX YYYY" = hectometers: 188362 440722 wordt "1884 4407". In Gelderland begint X met 1 of 2 (ongeveer 1400-2500) en Y met 4 (ongeveer 4150-5100); zo zie je snel of iets omgedraaid of fout is. Soms is het antwoord een woord, postcode of codewoord: lees de omschrijving van de hint goed.
- Een hintcoördinaat is waar de vossen wáren op het meldmoment (het hele uur), niet waar ze nu zijn.
- Opdrachten: max. punten en een deadline, één inzending (foto, tekst of YouTube-link). Het groepslogo of de vlag moet zichtbaar zijn; foto's liggend, JPG of PNG, max 2 MB, niet digitaal bewerkt tenzij toegestaan.
- Bekende puzzeltypes: Caesar/ROT, Morse, Braille en Elia, binair, 7-segment, weerstandskleurcode, KIX-code, Hexahue, Color Tokki, KennyCode, anagrammen, filippines, getallen in woorden (ook in andere of verzonnen talen, bv. Schots-Gaelisch aon, dhà, trì, ceithir, còig, sia, seachd, ochd, naoi, neoni), Ogham, Tengwar, stapeltellen (cijfersom tot 1 cijfer), trivia waarbij elk antwoord een cijfer geeft, afstand + richting vanaf HQ Jotihunt (coördinatenprojectie), kruispeiling, postcodes en adressen die lijnen of cijfers op de kaart tekenen, wachtwoorden voor .docx/.zip die uit de puzzel zelf komen (nooit brute-forcen).`;

function itemSection(item: ItemView, attachedImages: string[]): string {
  const lines = [`Soort: ${KIND_LABEL[item.kind]}`, `Titel: ${item.title}`, `Id: ${item.articleId}`, `Gepubliceerd: ${dutchDateTime(new Date(item.publishAt))}`];
  if (item.endTime) lines.push(`Deadline: ${dutchDateTime(new Date(item.endTime))}`);
  if (item.maxPoints !== null) lines.push(`Max punten: ${item.maxPoints}`);
  if (item.summary) lines.push(`Samenvatting: ${item.summary}`);
  if (item.attachments.length > 0) lines.push(`Bijlagen (niet leesbaar voor jou): ${item.attachments.join(", ")}`);
  if (item.images.length > 0) {
    const notAttached = item.images.map((image) => image.name).filter((name) => !attachedImages.includes(name));
    if (attachedImages.length > 0) lines.push(`Afbeeldingen van het item, in deze volgorde bijgevoegd bij het eerste bericht: ${attachedImages.join(", ")}`);
    if (notAttached.length > 0) lines.push(`Afbeeldingen die je niet kunt zien: ${notAttached.join(", ")}`);
  }
  lines.push("Tekst:", item.text || "(geen tekst)");
  if (item.hintCells.length > 0) {
    lines.push("Hintvakken:");
    for (const cell of item.hintCells) {
      const name = areaTitle(cell.area as AreaName);
      const status = cell.status === "solved" ? `opgelost, antwoord "${cell.answer ?? ""}"` : cell.status === "none" ? "geen hint" : "open";
      lines.push(`- ${name}: ${status}${cell.snippet ? ` | deel: ${cell.snippet.replace(/\n/g, " / ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** The Dutch system prompt of one chat turn */
export function buildSystemPrompt({ item, now, web, attachedImages }: { item: ItemView; now: Date; web: boolean; attachedImages: string[] }): string {
  const webRule = web
    ? "- Internet staat aan: gebruik webSearch voor feiten die je niet zeker weet en noem je bronnen kort."
    : '- Internet staat uit. Moet je iets opzoeken, zeg dan dat de gebruiker "Web" kan aanzetten.';
  return `Je bent de puzzel- en kaartassistent van het hoofdkwartier (HQ) van een scoutinggroep tijdens de Jotihunt. Je helpt een teamlid met het item dat nu open staat in het Intel-venster.

${GAME_RULES}

## Nu
${dutchDateTime(now)}

## Het open item
${itemSection(item, attachedImages)}

## Regels
- Antwoord kort en in het Nederlands. Markdown alleen voor korte lijstjes of een tabelletje.
- Gebruik je tools in plaats van te gokken: getItem, searchIntel, getHintBoard en getAreas voor gegevens uit de app; convertCoordinates voor elke omrekening van coördinaten.
${webRule}
- Zeg het duidelijk als iets een schatting of aanname is. Een deelgebied uit checkPoint is alleen zeker als method "hull" is; anders noem je het een schatting.
- Je kunt niets opslaan of wijzigen. Zeg nooit dat je iets hebt opgeslagen of ingevuld; de gebruiker doet dat zelf met de knop op het kaartje.
- Heb je een kandidaat-punt: roep altijd eerst checkPoint aan en eindig met showPoint, of met proposeHintAnswer als het een antwoord op een hintvak van dit item is.
- Leg in 1-3 zinnen uit hoe je tot een antwoord kwam (welke techniek). Weet je het niet zeker, zeg dat en geef de beste kandidaten.`;
}
```

- [ ] **Step 4: Implement** `src/services/intel-chat/messages.ts`

```ts
import type { ModelMessage, UIMessage } from "ai";
import type { FetchedImage } from "../article-media";

/** Messages sent to the model per turn (the newest ones) */
export const MAX_HISTORY_TO_MODEL = 40;
/** Messages kept per conversation */
export const MAX_STORED_MESSAGES = 200;
/** User images kept (stored and sent to the model); older ones become a text note (a chat document stays far below 16 MB) */
export const MAX_USER_IMAGES = 2;
export const MAX_USER_IMAGE_BYTES = 2 * 1024 * 1024;
export const USER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_USER_TEXT = 4000;
export const DROPPED_IMAGE_TEXT = "[eerder gestuurde afbeelding, niet meer bewaard]";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Decoded size of base64 data */
const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * The new user message of a POST, or null when it breaks the contract: `{ id, role: 'user', parts }` with exactly one
 * non-empty text part (max 4000 chars) and at most one file part (jpeg/png/webp as a base64 data: URL, max 2 MB).
 */
export function parseIncomingMessage(value: unknown): UIMessage | null {
  if (!isObject(value)) return null;
  const { id, role, parts } = value;
  if (typeof id !== "string" || !id || id.length > 100 || role !== "user" || !Array.isArray(parts)) return null;
  let text: string | null = null;
  let file: UIMessage["parts"][number] | null = null;
  for (const part of parts) {
    if (!isObject(part)) return null;
    if (part.type === "text" && typeof part.text === "string" && text === null) {
      text = part.text.trim();
    } else if (part.type === "file" && file === null) {
      const mediaType = part.mediaType;
      if (typeof mediaType !== "string" || !(USER_IMAGE_TYPES as readonly string[]).includes(mediaType) || typeof part.url !== "string") return null;
      const prefix = `data:${mediaType};base64,`;
      if (!part.url.startsWith(prefix)) return null;
      const data = part.url.slice(prefix.length);
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || base64Bytes(data) > MAX_USER_IMAGE_BYTES) return null;
      const filename = typeof part.filename === "string" ? part.filename.slice(0, 200) : undefined;
      file = { type: "file", mediaType, url: part.url, ...(filename ? { filename } : {}) };
    } else {
      return null;
    }
  }
  if (!text || text.length > MAX_USER_TEXT) return null;
  return { id, role: "user", parts: file ? [{ type: "text", text }, file] : [{ type: "text", text }] };
}

/**
 * The stored history with the new message at the end. A message whose id is already there (the client's "Opnieuw"
 * after an error) replaces it and everything after it.
 */
export function appendMessage(history: UIMessage[], message: UIMessage): UIMessage[] {
  const at = history.findIndex((known) => known.id === message.id);
  return [...(at >= 0 ? history.slice(0, at) : history), message];
}

const hasContent = (message: UIMessage) => message.parts.some((part) => part.type !== "step-start");

/**
 * The conversation as it is stored and sent: the newest MAX_STORED_MESSAGES, only the newest MAX_USER_IMAGES user
 * images (older ones replaced by a text note), streaming text marked done (an aborted turn), assistant messages without
 * content dropped.
 */
export function forStorage(messages: UIMessage[]): UIMessage[] {
  let imagesLeft = MAX_USER_IMAGES;
  const kept: UIMessage[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && !hasContent(message)) continue;
    const parts = message.parts.map((part) => {
      if (part.type === "file" && message.role === "user") {
        if (imagesLeft > 0) {
          imagesLeft--;
          return part;
        }
        return { type: "text" as const, text: DROPPED_IMAGE_TEXT };
      }
      if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") return { ...part, state: "done" as const };
      return part;
    });
    kept.push({ ...message, parts });
    if (kept.length >= MAX_STORED_MESSAGES) break;
  }
  return kept.reverse();
}

/** The newest MAX_HISTORY_TO_MODEL messages, starting at a user message */
export function modelWindow(messages: UIMessage[]): UIMessage[] {
  const window = messages.slice(-MAX_HISTORY_TO_MODEL);
  const firstUser = window.findIndex((message) => message.role === "user");
  return firstUser < 0 ? window : window.slice(firstUser);
}

/**
 * Attach the item's own images to the first user message sent to the model (once per turn, so the model always sees
 * them however long the chat is).
 */
export function withItemImages(messages: ModelMessage[], images: FetchedImage[]): ModelMessage[] {
  if (images.length === 0) return messages;
  const at = messages.findIndex((message) => message.role === "user");
  if (at < 0) return messages;
  const first = messages[at];
  if (first.role !== "user") return messages;
  const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  const attached = [
    { type: "text" as const, text: `Afbeeldingen van het open item: ${images.map((image) => image.name).join(", ")}` },
    ...images.map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mediaType, filename: image.name })),
  ];
  return [...messages.slice(0, at), { ...first, content: [...attached, ...content] }, ...messages.slice(at + 1)];
}
```

- [ ] **Step 5: Implement** `src/services/intel-chat/item-images.ts`

```ts
import { articleImages, fetchImages, type ArticleImage, type FetchedImage } from "../article-media";

/** Downloaded item images are reused for this long (every chat turn sends them again) */
export const ITEM_IMAGE_CACHE_MS = 10 * 60_000;
const MAX_CACHED_ITEMS = 3;

const cache = new Map<string, { at: number; images: Promise<FetchedImage[]> }>();

/** Tests only */
export function clearItemImageCache() {
  cache.clear();
}

/**
 * The item's images for the model, with the same rules as the summaries (fetchImages: at most 20, 5 MB each, 14 MB in
 * total, https on jotihunt.net/.nl only). Cached per article content for 10 minutes; never throws (text only then).
 */
export async function loadItemImages(
  article: { id: number; content: string; contentHash?: string | null },
  download: (images: ArticleImage[]) => Promise<FetchedImage[]> = (images) => fetchImages(images),
  now = Date.now(),
): Promise<FetchedImage[]> {
  const images = articleImages(article.content);
  if (images.length === 0) return [];
  const key = `${article.id}:${article.contentHash ?? article.content.length}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ITEM_IMAGE_CACHE_MS) return hit.images;
  const loading = download(images).catch(() => []);
  cache.delete(key);
  cache.set(key, { at: now, images: loading });
  while (cache.size > MAX_CACHED_ITEMS) cache.delete(cache.keys().next().value!);
  return loading;
}
```

- [ ] **Step 6: Run the test, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/messages.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 10 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/services/intel-chat/prompt.ts src/services/intel-chat/messages.ts src/services/intel-chat/item-images.ts src/services/intel-chat/messages.test.ts
git commit -m "feat(intel-chat): system prompt, message rules and item images" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 8: Tool registry and agent (P1)

**Files:**
- Create: `src/services/intel-chat/tools/index.ts`, `src/services/intel-chat/agent.ts`
- Modify: `src/test/ai.ts` (add `mockStreamModel`)
- Test: `src/services/intel-chat/agent.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-7.
- Produces:
  - `createIntelTools(ctx)`, `IntelTools`, `activeToolNames(tools, web)`, re-export `IntelToolContext`
  - `IntelChatModels { chat, deep, tool }`, `MAX_STEPS = 12`, `TURN_TIMEOUT_MS = 150_000`, `DEEP_TURN_TIMEOUT_MS = 300_000`, `IntelChatTurn`, `streamIntelChat(turn): Promise<ReadableStream<UIMessageChunk>>`
  - test helper `StreamStep { text?, toolCalls?: { id, name, input }[] }`, `mockStreamModel(steps)` (a `MockLanguageModelV4` whose `doStreamCalls` hold prompt, tools and providerOptions)

Verified against ai 7.0.127 (spike): `streamText({ instructions, messages, tools, activeTools, stopWhen: isStepCount(n), providerOptions })` → `toUIMessageStream({ stream: result.stream, tools, originalMessages, generateMessageId, onEnd })` → `pipeUIMessageStreamToResponse({ response, stream })` sends `x-vercel-ai-ui-message-stream: v1`; `onEnd({ messages })` gets history + the assistant message (tool parts `tool-<name>` with `state: "output-available"`), also when the client disconnects (`isCancelled`), with the text produced so far. `activeTools` limits the tool declarations sent to the model. `streamText`'s `system` is deprecated in v7: use `instructions`. `sendReasoning: false` keeps thought text out of the stored messages (Gemini's thought signatures ride on tool-call provider metadata, which is kept).

- [ ] **Step 1: Add `mockStreamModel`** to `src/test/ai.ts`

Change the `ai/test` import to:

```ts
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
```

and append:

```ts
/** One model step of a scripted stream: text, and/or tool calls (input as an object) */
export interface StreamStep {
  text?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
}

/**
 * A streaming model that answers step by step from `steps` (the last step repeats). Calls are in `doStreamCalls`
 * (prompt, tools, providerOptions).
 */
export function mockStreamModel(steps: StreamStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (step.text !== undefined) parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: step.text }, { type: "text-end", id: "t" });
      for (const toolCall of step.toolCalls ?? []) parts.push({ type: "tool-call", toolCallId: toolCall.id, toolName: toolCall.name, input: JSON.stringify(toolCall.input) });
      parts.push({ type: "finish", usage, finishReason: { unified: step.toolCalls?.length ? "tool-calls" : "stop", raw: undefined } });
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  });
}
```

- [ ] **Step 2: Write the failing test** `src/services/intel-chat/agent.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { convertReadableStreamToArray } from "ai/test";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { mockModel, mockStreamModel, type StreamStep } from "../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { streamIntelChat, type IntelChatModels } from "./agent";
import { clearItemImageCache } from "./item-images";
import { loadItemView } from "./tools/app-data";

const NOW = new Date("2026-10-17T12:05:00Z");
const CONTENT = '<div>Alpha: <img src="https://cdn.jotihunt.net/a.png" alt="alpha.png"></div>';
const question: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Los Alpha op" }] };

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clearItemImageCache();
  await Article.create({ id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: CONTENT, contentHash: "h" });
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open });
});
afterAll(disconnectTestDb);

async function runTurn(steps: StreamStep[], options: { web?: boolean; deep?: boolean } = {}) {
  const chat = mockStreamModel(steps);
  const deep = mockStreamModel(steps);
  const models: IntelChatModels = { chat, deep, tool: mockModel(() => "") };
  let saved: UIMessage[] | null = null;
  const stream = await streamIntelChat({
    models,
    item: (await loadItemView(10))!,
    article: { id: 10, content: CONTENT, contentHash: "h" },
    conversation: [question],
    web: options.web ?? false,
    deep: options.deep ?? false,
    now: NOW,
    abortSignal: new AbortController().signal,
    onEnd: (messages) => {
      saved = messages;
    },
    downloadImages: async () => [{ name: "alpha.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }],
  });
  const chunks = await convertReadableStreamToArray(stream);
  return { chunks, saved: saved as UIMessage[] | null, chat, deep };
}

describe("streamIntelChat", () => {
  test("runs a tool, streams the answer and hands every message to onEnd", async () => {
    const { chunks, saved } = await runTurn([{ toolCalls: [{ id: "c1", name: "proposeHintAnswer", input: { area: "alpha", answer: "1884 4407" } }] }, { text: "Alpha staat klaar." }]);
    expect(chunks.find((chunk) => chunk.type === "tool-output-available")).toMatchObject({ toolCallId: "c1", output: { area: "alpha", answer: "1884 4407", kind: "rd" } });
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => (chunk as { delta: string }).delta).join("")).toBe("Alpha staat klaar.");
    expect(saved?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(saved?.[1].parts.map((part) => part.type)).toEqual(["step-start", "tool-proposeHintAnswer", "step-start", "text"]);
  });

  test("system prompt, item images on the first user message, web tools off by default", async () => {
    const { chat } = await runTurn([{ text: "ok" }]);
    const call = chat.doStreamCalls[0];
    expect(call.prompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(call.prompt[0])).toContain("Titel: Hint 10");
    const firstUser = call.prompt.find((message) => message.role === "user")!;
    expect(JSON.stringify(firstUser.content)).toContain("Afbeeldingen van het open item: alpha.png");
    expect((firstUser.content as { type: string }[]).some((part) => part.type === "file")).toBe(true);
    const names = call.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("getItem");
    expect(names).toContain("proposeHintAnswer");
    expect(names).not.toContain("webSearch");
    expect(call.providerOptions?.google).toBeUndefined();
  });

  test("web on offers webSearch; deep uses the deep model with high thinking", async () => {
    const { chat, deep } = await runTurn([{ text: "ok" }], { web: true, deep: true });
    expect(chat.doStreamCalls).toHaveLength(0);
    const call = deep.doStreamCalls[0];
    expect(call.tools?.map((tool) => tool.name)).toContain("webSearch");
    expect(call.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" } } });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/agent.test.ts`
Expected: FAIL (cannot find module `./agent`).

- [ ] **Step 4: Implement** `src/services/intel-chat/tools/index.ts`

```ts
import { appDataTools } from "./app-data";
import type { IntelToolContext } from "./context";
import { mapTools } from "./map";
import { proposalTools } from "./proposals";
import { WEB_TOOL_NAMES, webTools } from "./web";

export type { IntelToolContext } from "./context";

/** Every tool of the Intel chat; names are binding for the client (UI part type `tool-<name>`) */
export function createIntelTools(ctx: IntelToolContext) {
  return { ...appDataTools(ctx), ...mapTools(ctx), ...proposalTools(ctx), ...webTools(ctx) };
}

export type IntelTools = ReturnType<typeof createIntelTools>;

/** The tools the model may call this turn: the web tools only with "Web" on */
export function activeToolNames(tools: IntelTools, web: boolean): (keyof IntelTools)[] {
  return (Object.keys(tools) as (keyof IntelTools)[]).filter((name) => web || !(WEB_TOOL_NAMES as readonly string[]).includes(name));
}
```

- [ ] **Step 5: Implement** `src/services/intel-chat/agent.ts`

```ts
import { convertToModelMessages, generateId, isStepCount, streamText, toUIMessageStream, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { toGeminiError } from "../ai/gemini-error";
import type { ArticleImage, FetchedImage } from "../article-media";
import { loadItemImages } from "./item-images";
import { modelWindow, withItemImages } from "./messages";
import { buildSystemPrompt } from "./prompt";
import type { ItemView } from "./tools/app-data";
import { activeToolNames, createIntelTools, type IntelToolContext } from "./tools";

/** The models of the chat: normal turns, "Denk diep" turns, and the web/code sub-calls */
export interface IntelChatModels {
  chat: LanguageModel;
  deep: LanguageModel;
  tool: LanguageModel;
}

/** Model steps per turn (each tool round is a step) */
export const MAX_STEPS = 12;
/** Total time of one turn, all steps and tools included */
export const TURN_TIMEOUT_MS = 150_000;
export const DEEP_TURN_TIMEOUT_MS = 300_000;

export interface IntelChatTurn {
  models: IntelChatModels;
  item: ItemView;
  article: { id: number; content: string; contentHash?: string | null };
  /** Stored history + the new user message (see forStorage); also the stream's originalMessages */
  conversation: UIMessage[];
  web: boolean;
  deep: boolean;
  now: Date;
  /** Aborts the turn (client gone) */
  abortSignal: AbortSignal;
  /** Called once with every message when the stream ends (finished, failed or aborted) */
  onEnd: (messages: UIMessage[]) => Promise<void> | void;
  /** Tools: walkMinutes, fetch, lookup (tests and instance wiring) */
  toolContext?: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">>;
  /** Tests: the item image download */
  downloadImages?: (images: ArticleImage[]) => Promise<FetchedImage[]>;
}

/**
 * One chat turn: the model (deep → pro model with high thinking) streams an answer, calling our tools (web tools only
 * with `web`), at most MAX_STEPS steps. Returns the UI message stream for pipeUIMessageStreamToResponse.
 */
export async function streamIntelChat(turn: IntelChatTurn): Promise<ReadableStream<UIMessageChunk>> {
  const tools = createIntelTools({ articleId: turn.item.articleId, now: () => turn.now, toolModel: turn.models.tool, ...turn.toolContext });
  const images = await loadItemImages(turn.article, turn.downloadImages);
  const messages = withItemImages(await convertToModelMessages(modelWindow(turn.conversation), { tools, ignoreIncompleteToolCalls: true }), images);
  const result = streamText({
    model: turn.deep ? turn.models.deep : turn.models.chat,
    instructions: buildSystemPrompt({ item: turn.item, now: turn.now, web: turn.web, attachedImages: images.map((image) => image.name) }),
    messages,
    tools,
    activeTools: activeToolNames(tools, turn.web),
    stopWhen: isStepCount(MAX_STEPS),
    providerOptions: turn.deep ? { google: { thinkingConfig: { thinkingLevel: "high" } } } : undefined,
    maxRetries: 1,
    abortSignal: AbortSignal.any([turn.abortSignal, AbortSignal.timeout(turn.deep ? DEEP_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS)]),
  });
  return toUIMessageStream({
    stream: result.stream,
    tools,
    originalMessages: turn.conversation,
    generateMessageId: generateId,
    sendReasoning: false,
    sendSources: false,
    // Only our own Dutch message: a raw API error holds the request (with the key)
    onError: (error) => toGeminiError(error).message,
    onEnd: async ({ messages: all }) => {
      await turn.onEnd(all);
    },
  });
}
```

- [ ] **Step 6: Run the test, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/agent.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 3 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/test/ai.ts src/services/intel-chat/tools/index.ts src/services/intel-chat/agent.ts src/services/intel-chat/agent.test.ts
git commit -m "feat(intel-chat): agent streams a turn with our tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 9: Routes, controller, rate limit, app wiring (P1 complete)

**Files:**
- Modify: `src/middleware/rate-limit.ts` (+ test), `src/app.ts`
- Create: `src/services/intel-chat/instance.ts`, `src/controllers/intel-chat.controller.ts`, `src/routes/intel-chat.route.ts`
- Test: `src/routes/intel-chat.route.test.ts`, `src/middleware/rate-limit.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 7, 8.
- Produces:
  - `RateLimitOptions.body?: Record<string, unknown>` (429 body; default unchanged)
  - `getIntelChatModels(): IntelChatModels | null`, `setIntelChatModels(value | null | undefined)` (tests; `undefined` = from the environment again), `getIntelToolDeps()`, `setIntelToolDeps(value)`
  - `getChat`, `postChat`, `deleteChat` handlers; router mounted at `/intel-chat`; `INTEL_CHAT_LIMIT = { max: 30, windowMs: 600_000 }`

Decisions:
- Order of checks: auth (401) → rate limit (POST, 429, counted before validation) → `articleId` param (400 from express-validator) → article (404) → AI configured (503) → message (400 `invalid_message`). `GET` also answers 503 without Gemini so the client can show "AI is niet ingesteld" straight away; `DELETE` works without Gemini.
- Body limit: the global `express.json()` keeps its 100 kB default; `/intel-chat` gets its own `express.json({ limit: "4mb" })` mounted before it (a 2 MB image is ~2.8 MB of base64).
- Compression: `compressible("text/event-stream")` is true, so the filter now refuses event streams explicitly (gzip would hold the chunks back).
- Save rule: in `onEnd` (finished, failed or aborted), skipped when the demo generation changed meanwhile (the default connection points at another database then). A client that leaves aborts the turn (`res.on("close")`).

- [ ] **Step 1: Write the failing rate-limit test**: append inside `describe("limitRate", ...)` in `src/middleware/rate-limit.test.ts`:

```ts
  test("answers the 429 with a custom body when given", () => {
    clock = 0;
    const limit = limitRate({ windowMs: 1000, max: 1, key: () => "k", body: { error: "rate_limited" }, now: () => clock });
    expect(attempt(limit, "a", 200).passed).toBe(true);
    const blocked = attempt(limit, "a", 200);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.body).toEqual({ error: "rate_limited" });
  });
```

Run: `npx --yes bun test src/middleware/rate-limit.test.ts` → FAIL (body is `{ message }`), and tsc reports the unknown `body` option.

- [ ] **Step 2: Add the `body` option** in `src/middleware/rate-limit.ts`: in `RateLimitOptions` add after `maxKeys?`:

```ts
  /** Body of the 429 (default a Dutch `message`) */
  body?: Record<string, unknown>;
```

above `limitRate` add:

```ts
const TOO_MANY = { message: "Te veel verzoeken achter elkaar, wacht even en probeer het opnieuw." };
```

change the signature to `export function limitRate({ windowMs, max, key, maxKeys = DEFAULT_MAX_KEYS, body = TOO_MANY, now = Date.now }: RateLimitOptions)` and the 429 line to `return res.status(429).json(body);`.

Run: `npx --yes bun test src/middleware/rate-limit.test.ts` → PASS.

- [ ] **Step 3: Write the failing route test** `src/routes/intel-chat.route.test.ts`

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UIMessage } from "ai";
import type mongoose from "mongoose";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { IntelChat } from "../models/intel-chat.model";
import { User } from "../models/user.model";
import { setIntelChatModels } from "../services/intel-chat/instance";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { mockModel, mockStreamModel, type StreamStep } from "../test/ai";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

let server: Server;
let base: string;
let chat: ReturnType<typeof mockStreamModel>;

beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await Article.create([
    { id: 10, title: "Hint 10", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "<div>Alpha: 1884 4407 in Caesar</div>" },
    { id: 900001, title: "Testhint", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "x" },
  ]);
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: new Date("2026-10-17T12:00:00Z"), slotTime: new Date("2026-10-17T12:00:00Z"), status: HintCellStatus.Open });
  useSteps([{ text: "Hallo!" }]);
});
afterEach(() => setIntelChatModels(undefined));
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

function useSteps(steps: StreamStep[]) {
  chat = mockStreamModel(steps);
  setIntelChatModels({ chat, deep: chat, tool: mockModel(() => "") });
}

let userCount = 0;
const createUser = async () => withSession(await User.create({ name: `Hunter ${++userCount}` }));

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

const question = (id: string, text = "Los Alpha op"): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const ask = (token: string, message: unknown, extra: Record<string, unknown> = {}) => request("/intel-chat/10", { method: "POST", token, json: { message, web: false, deep: false, ...extra } });

/** Wait until the stream's onEnd saved the chat */
async function savedMessages(userId: mongoose.Types.ObjectId, count: number): Promise<UIMessage[]> {
  for (let i = 0; i < 50; i++) {
    const chat = await IntelChat.findOne({ userId, articleId: 10 }).lean();
    if ((chat?.messages.length ?? 0) >= count) return chat!.messages as UIMessage[];
    await Bun.sleep(20);
  }
  throw new Error("chat was not saved");
}

describe("/intel-chat", () => {
  test("needs a login", async () => {
    expect((await request("/intel-chat/10")).status).toBe(401);
    expect((await request("/intel-chat/10", { method: "POST", json: {} })).status).toBe(401);
    expect((await request("/intel-chat/10", { method: "DELETE" })).status).toBe(401);
  });

  test("404 for a missing or hidden test article", async () => {
    const token = tokenFor(await createUser());
    for (const id of [5, 900001]) {
      expect(await (await request(`/intel-chat/${id}`, { token })).json()).toEqual({ error: "not_found" });
      expect((await request(`/intel-chat/${id}`, { method: "POST", token, json: { message: question("m1") } })).status).toBe(404);
      expect((await request(`/intel-chat/${id}`, { method: "DELETE", token })).status).toBe(404);
    }
  });

  test("503 ai_unavailable without Gemini", async () => {
    setIntelChatModels(null);
    const token = tokenFor(await createUser());
    const res = await ask(token, question("m1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_unavailable" });
    expect((await request("/intel-chat/10", { token })).status).toBe(503);
  });

  test("400 invalid_message", async () => {
    const token = tokenFor(await createUser());
    for (const message of [undefined, { id: "x", role: "assistant", parts: [{ type: "text", text: "hoi" }] }, { id: "x", role: "user", parts: [] }]) {
      const res = await ask(token, message);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_message" });
    }
  });

  test("POST streams the answer and saves the conversation; GET returns it; DELETE clears it", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect(await (await request("/intel-chat/10", { token })).json()).toEqual({ messages: [] });

    const res = await ask(token, question("m1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("Hallo!");

    const saved = await savedMessages(user._id, 2);
    expect(saved[0]).toEqual(question("m1"));
    expect(saved[1]).toMatchObject({ role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "Hallo!" }] });
    expect((await (await request("/intel-chat/10", { token })).json()).messages).toEqual(saved);

    // Another user sees nothing
    expect(await (await request("/intel-chat/10", { token: tokenFor(await createUser()) })).json()).toEqual({ messages: [] });

    expect((await request("/intel-chat/10", { method: "DELETE", token })).status).toBe(204);
    expect(await (await request("/intel-chat/10", { token })).json()).toEqual({ messages: [] });
  });

  test("the next question goes to the model with the history; web off hides the web tools", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await (await ask(token, question("m1", "eerste vraag"))).text();
    await savedMessages(user._id, 2);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    await savedMessages(user._id, 4);
    const prompt = JSON.stringify(chat.doStreamCalls[1].prompt);
    expect(prompt).toContain("eerste vraag");
    expect(prompt).toContain("Hallo!");
    expect(prompt).toContain("tweede vraag");
    expect(chat.doStreamCalls[1].tools?.map((tool) => tool.name)).not.toContain("webSearch");
    await (await ask(token, question("m3"), { web: true })).text();
    expect(chat.doStreamCalls[2].tools?.map((tool) => tool.name)).toContain("webSearch");
  });

  test("posting a known message id again (Opnieuw) replaces it and what followed, never duplicates", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await (await ask(token, question("m1", "eerste vraag"))).text();
    await savedMessages(user._id, 2);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    await savedMessages(user._id, 4);
    useSteps([{ text: "Nieuw antwoord" }]);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    let saved: UIMessage[] = [];
    for (let i = 0; i < 50; i++) {
      saved = (await IntelChat.findOne({ userId: user._id, articleId: 10 }).lean())!.messages as UIMessage[];
      if (JSON.stringify(saved).includes("Nieuw antwoord")) break;
      await Bun.sleep(20);
    }
    expect(saved.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(saved.filter((message) => message.id === "m2")).toHaveLength(1);
    expect(saved[3].parts.find((part) => part.type === "text")).toMatchObject({ text: "Nieuw antwoord" });
    const prompt = JSON.stringify(chat.doStreamCalls[0].prompt);
    expect(prompt.match(/tweede vraag/g)).toHaveLength(1);
  });

  test("a tool call is streamed and stored as a tool part", async () => {
    useSteps([{ toolCalls: [{ id: "c1", name: "showPoint", input: { point: "1884 4407", label: "HQ" } }] }, { text: "Daar." }]);
    const user = await createUser();
    const token = tokenFor(user);
    const body = await (await ask(token, question("m1"))).text();
    expect(body).toContain('"type":"tool-output-available"');
    const saved = await savedMessages(user._id, 2);
    expect(saved[1].parts.find((part) => part.type === "tool-showPoint")).toMatchObject({ state: "output-available", output: { label: "HQ", rdText: "1884 4407" } });
  });

  test("an image up to 2 MB fits through the body parser", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    const url = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024, 7).toString("base64")}`;
    const res = await ask(token, { ...question("m1"), parts: [{ type: "text", text: "kijk" }, { type: "file", mediaType: "image/png", url }] });
    expect(res.status).toBe(200);
    await res.text();
    const saved = await savedMessages(user._id, 2);
    expect(saved[0].parts[1]).toMatchObject({ type: "file", mediaType: "image/png" });
  });

  test("a question the client walks away from is saved with what was produced", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const slow = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 50,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            ...Array.from({ length: 40 }, (_, i) => ({ type: "text-delta" as const, id: "t", delta: `w${i} ` })),
            { type: "text-end", id: "t" },
            { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
          ],
        }),
      }),
    });
    setIntelChatModels({ chat: slow, deep: slow, tool: mockModel(() => "") });
    const user = await createUser();
    const abort = new AbortController();
    const res = await request("/intel-chat/10", { method: "POST", token: tokenFor(user), json: { message: question("m1"), web: false, deep: false }, signal: abort.signal });
    const reader = res.body!.getReader();
    await reader.read();
    await Bun.sleep(300);
    abort.abort();
    const saved = await savedMessages(user._id, 2);
    const text = saved[1].parts.find((part) => part.type === "text") as { text: string; state: string };
    expect(text.text).toStartWith("w0 ");
    expect(text.text.length).toBeLessThan(40 * 4);
    expect(text.state).toBe("done");
  });

  test("429 rate_limited after 30 questions in 10 minutes", async () => {
    const token = tokenFor(await createUser());
    for (let i = 0; i < 30; i++) expect((await ask(token, undefined)).status).toBe(400);
    const res = await ask(token, question("m1"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx --yes bun test src/routes/intel-chat.route.test.ts`
Expected: FAIL (cannot find module `../services/intel-chat/instance`).

- [ ] **Step 5: Implement** `src/services/intel-chat/instance.ts`

```ts
import { createModels } from "../ai/model";
import type { IntelChatModels } from "./agent";
import type { IntelToolContext } from "./tools";

let models: IntelChatModels | null | undefined;
let toolDeps: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">> = {};

/** The chat's models (purpose chat; "Denk diep" uses the prediction model); null without GEMINI_API_KEY */
export function getIntelChatModels(): IntelChatModels | null {
  if (models === undefined) {
    const byPurpose = createModels();
    models = byPurpose ? { chat: byPurpose("chat"), deep: byPurpose("prediction"), tool: byPurpose("chat") } : null;
  }
  return models;
}

/** Tests: other models (null = AI off, undefined = from the environment again) */
export function setIntelChatModels(value: IntelChatModels | null | undefined) {
  models = value;
}

/** Extra tool dependencies of the running server */
export function getIntelToolDeps() {
  return toolDeps;
}

/** Tests: fake fetch / DNS / walking */
export function setIntelToolDeps(value: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">>) {
  toolDeps = value;
}
```

- [ ] **Step 6: Implement** `src/controllers/intel-chat.controller.ts`

```ts
import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Request, Response } from "express";
import { currentGeneration } from "../demo/demo-mode";
import { logger } from "../logger";
import { streamIntelChat } from "../services/intel-chat/agent";
import { getIntelChatModels, getIntelToolDeps } from "../services/intel-chat/instance";
import { appendMessage, forStorage, parseIncomingMessage } from "../services/intel-chat/messages";
import { clearChat, loadChat, saveChat } from "../services/intel-chat/store";
import { findPublicArticle, loadItemView } from "../services/intel-chat/tools/app-data";

const articleIdOf = (req: Request) => Number(req.params.articleId);
const notFound = (res: Response) => res.status(404).json({ error: "not_found" });
const aiUnavailable = (res: Response) => res.status(503).json({ error: "ai_unavailable" });

/** GET /intel-chat/:articleId → { messages } */
export async function getChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  if (!getIntelChatModels()) return aiUnavailable(res);
  return res.status(200).json({ messages: await loadChat(req.user!._id, articleId) });
}

/** DELETE /intel-chat/:articleId → 204 ("Nieuw gesprek") */
export async function deleteChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  await clearChat(req.user!._id, articleId);
  return res.status(204).end();
}

/**
 * POST /intel-chat/:articleId { message, web, deep } → UI message stream. The stored history plus the new message go to
 * the model; when the stream ends (also after an abort or error) everything produced is saved, unless the database
 * was switched (demo) meanwhile.
 */
export async function postChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  const article = await findPublicArticle(articleId);
  if (!article) return notFound(res);
  const models = getIntelChatModels();
  if (!models) return aiUnavailable(res);
  const message = parseIncomingMessage(req.body?.message);
  if (!message) return res.status(400).json({ error: "invalid_message" });

  const userId = req.user!._id;
  const item = await loadItemView(articleId);
  if (!item) return notFound(res);
  const conversation = forStorage(appendMessage(await loadChat(userId, articleId), message));
  const generation = currentGeneration();
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const stream = await streamIntelChat({
    models,
    item,
    article,
    conversation,
    web: req.body.web === true,
    deep: req.body.deep === true,
    now: new Date(),
    abortSignal: abort.signal,
    toolContext: getIntelToolDeps(),
    onEnd: async (messages: UIMessage[]) => {
      if (currentGeneration() !== generation) return;
      try {
        await saveChat(userId, articleId, forStorage(messages));
      } catch (error) {
        logger.error(`Could not save the intel chat of item ${articleId}`, error);
      }
    },
  });
  await pipeUIMessageStreamToResponse({ response: res, stream });
}
```

- [ ] **Step 7: Implement** `src/routes/intel-chat.route.ts`

```ts
import express from "express";
import { param } from "express-validator";
import * as intelChatController from "../controllers/intel-chat.controller";
import verifyToken from "../middleware/auth.middleware";
import { limitRate } from "../middleware/rate-limit";
import { validate } from "../middleware/validate.middleware";

/** 30 questions per 10 minutes per user (each one is several Gemini calls) */
export const INTEL_CHAT_LIMIT = { max: 30, windowMs: 10 * 60_000 };

const articleParam = validate([param("articleId").isInt({ min: 0 })]);
const limitQuestions = limitRate({ ...INTEL_CHAT_LIMIT, key: (req) => req.user?._id.toString() ?? req.ip ?? "", body: { error: "rate_limited" } });

const router = express.Router();

router.get("/:articleId", [verifyToken, articleParam], intelChatController.getChat);
router.post("/:articleId", [verifyToken, limitQuestions, articleParam], intelChatController.postChat);
router.delete("/:articleId", [verifyToken, articleParam], intelChatController.deleteChat);

export default router;
```

- [ ] **Step 8: Wire the app** (`src/app.ts`)

Import (after `sentryTunnelRoute`):

```ts
import intelChatRoute from "./routes/intel-chat.route";
```

Replace the `app.use(compression(...))` call with (keep the comment lines above it and add the new one):

```ts
// Never the AI chat's event stream: gzip would hold its chunks back
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type"));
      if (/event-stream/.test(type)) return false;
      return /x-protobuf/.test(type) || compression.filter(req, res);
    },
  }),
);
```

Directly before `app.use(express.json());`:

```ts
// AI chat questions may carry one image (≤ 2 MB, base64 in JSON); every other route keeps the 100 kB default
app.use("/intel-chat", express.json({ limit: "4mb" }));
```

After `app.use("/happy-hour", happyHourRoute);`:

```ts
// AI chat per user per Intel item (Gemini with our tools; the AI never writes)
app.use("/intel-chat", intelChatRoute);
```

- [ ] **Step 9: Run the route test, typecheck, lint**

Run: `npx --yes bun test src/routes/intel-chat.route.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 11 pass, 0 fail.

- [ ] **Step 10: P1 checkpoint: full suite**

Run: `npx --yes bun test --timeout 30000`
Expected: all pass (if a known load-flaky demo database-switch timeout shows up, rerun `npx --yes bun test --timeout 30000 src/demo` alone to confirm it passes).

- [ ] **Step 11: Commit**

```bash
git add src/middleware/rate-limit.ts src/middleware/rate-limit.test.ts src/services/intel-chat/instance.ts src/controllers/intel-chat.controller.ts src/routes/intel-chat.route.ts src/routes/intel-chat.route.test.ts src/app.ts
git commit -m "feat(intel-chat): GET/POST/DELETE /intel-chat/:articleId" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The P1 cut is now complete and shippable.

### Task 10: getFoxHistory and getOurTeams

**Files:**
- Modify: `src/services/intel-chat/tools/app-data.ts`
- Test: `src/services/intel-chat/tools/fox-history.test.ts`

**Interfaces:**
- Consumes: `loadTrackers` (Task 3), `coordinateAt` / `formatCoordinate` (Task 2), `Hunt`, `HuntReport`, `Prediction` models.
- Produces: `FoxEvent { time, kind: "hunt" | "hunt-report" | "hint", detail, latLng, rdText }`, `foxHistory(area)` → `{ area, events: FoxEvent[], prediction }`, `ourTeams(now)` → `{ trackers: { name, source, latLng, rdText, ageMin }[] }`; tools `getFoxHistory`, `getOurTeams` added to `appDataTools`.

Note: `Hunt.area` comes from the jotihunt.nl scraper with the site's casing ("Alpha"), so it is matched case-insensitively; `HuntReport.area` and `HintCell.area` are lowercase.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/tools/fox-history.test.ts`

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Hunt } from "../../../models/hunt.model";
import { HuntReport } from "../../../models/hunt-report.model";
import { Prediction } from "../../../models/prediction.model";
import { setLife360Service, type Life360Service } from "../../life360.service";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { appDataTools } from "./app-data";

const NOW = new Date("2026-10-17T15:00:00Z");
const tools = appDataTools({ articleId: 10, now: () => NOW, toolModel: mockModel(() => "") });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterEach(() => setLife360Service(null));
afterAll(disconnectTestDb);

describe("getFoxHistory", () => {
  test("hunts, hunt reports and solved hints of the area, oldest first, plus the prediction", async () => {
    await Article.create({ id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: "x" });
    await Hunt.create([
      { area: "Alpha", huntCode: "A1", status: "goedgekeurd", points: 6, huntTime: new Date("2026-10-17T13:00:00Z"), updatedAt: NOW },
      { area: "Bravo", huntCode: "B1", status: "goedgekeurd", points: 3, huntTime: new Date("2026-10-17T13:00:00Z"), updatedAt: NOW },
    ]);
    await HuntReport.create({ area: "alpha", photo: "p.jpg", reportedBy: new mongoose.Types.ObjectId(), reportedByName: "Anna", huntTime: new Date("2026-10-17T14:00:00Z"), location: { type: "Point", coordinates: [5.87252, 51.95392] } });
    await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: new Date("2026-10-17T12:00:00Z"), status: HintCellStatus.Solved, answer: "1884 4407", answerKind: "rd", answerLocation: [5.87252, 51.95392] });
    await Prediction.create({ area: "alpha", status: "ok", updatedAt: NOW, pin: { lat: 52, lng: 5.9 }, confidence: "medium", why: "loopt naar het oosten" });
    const history = (await runTool(tools.getFoxHistory, { area: "Alpha" })) as { area: string; events: { kind: string; detail: string; rdText: string | null }[]; prediction: Record<string, unknown> };
    expect(history.area).toBe("alpha");
    expect(history.events.map((event) => event.kind)).toEqual(["hint", "hunt", "hunt-report"]);
    expect(history.events[0]).toMatchObject({ detail: 'hint "Hint 10": 1884 4407', rdText: "1884 4407" });
    expect(history.events[1]).toMatchObject({ detail: "hunt op jotihunt.nl: goedgekeurd, 6 punten", rdText: null });
    expect(history.events[2]).toMatchObject({ detail: "hunt gemeld door Anna", rdText: "1884 4407" });
    expect(history.prediction).toMatchObject({ pin: { lat: 52, lng: 5.9 }, confidence: "medium", why: "loopt naar het oosten" });
  });

  test("unknown area is an error; an area without anything is empty", async () => {
    expect(await runTool(tools.getFoxHistory, { area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
    expect(await runTool(tools.getFoxHistory, { area: "oscar" })).toEqual({ area: "oscar", events: [], prediction: null });
  });
});

describe("getOurTeams", () => {
  test("Life360 members with position, RD and age (Traccar is not configured in tests)", async () => {
    setLife360Service({
      members: () => ({
        linked: true,
        stale: false,
        members: [{ id: "a", name: "Anna B.", initials: "AB", avatarUrl: null, location: { lat: 51.95392, lon: 5.87252, accuracyM: 10, at: "2026-10-17T14:50:00Z", driving: false, speedKmh: null, battery: null, charging: false } }],
      }),
    } as unknown as Life360Service);
    expect(await runTool(tools.getOurTeams, {})).toEqual({ trackers: [{ name: "Anna B.", source: "life360", latLng: { lat: 51.95392, lng: 5.87252 }, rdText: "1884 4407", ageMin: 10 }] });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/tools/fox-history.test.ts`
Expected: FAIL (`tools.getFoxHistory` is undefined: "Tool has no execute" / TypeError).

- [ ] **Step 3: Implement** in `src/services/intel-chat/tools/app-data.ts`

Add after the `Area` model import:

```ts
import { Hunt } from "../../../models/hunt.model";
import { HuntReport } from "../../../models/hunt-report.model";
import { Prediction } from "../../../models/prediction.model";
```

Add before `import { safely, ToolInputError, type IntelToolContext } from "./context";`:

```ts
import { loadTrackers } from "../data";
import { coordinateAt, formatCoordinate } from "../geo";
```

Add before `export function appDataTools`:

```ts
export interface FoxEvent {
  time: string;
  kind: "hunt" | "hunt-report" | "hint";
  detail: string;
  latLng: { lat: number; lng: number } | null;
  rdText: string | null;
}

const MAX_FOX_EVENTS = 30;
const at = (lng: number, lat: number) => ({ latLng: { lat, lng }, rdText: formatCoordinate(coordinateAt({ lat, lng })).rd8 });

/** What we know of one fox team, oldest first (the newest 30): site hunts, our hunt reports, solved hint points, and the latest prediction */
export async function foxHistory(area: string) {
  const key = knownAreaName(area);
  if (!key) throw new ToolInputError(`Onbekend deelgebied: ${area}`);
  const [hunts, reports, cells, prediction] = await Promise.all([
    Hunt.find({ area: new RegExp(`^${key}$`, "i") }).sort({ huntTime: -1 }).limit(MAX_FOX_EVENTS).lean(),
    HuntReport.find({ area: key }).sort({ createdAt: -1 }).limit(MAX_FOX_EVENTS).lean(),
    HintCell.find({ area: key, status: HintCellStatus.Solved, articleId: publicArticlesFilter().id }).sort({ slotTime: -1 }).limit(MAX_FOX_EVENTS).lean(),
    Prediction.findOne({ area: key }).lean(),
  ]);
  const titles = new Map((await Article.find({ id: { $in: cells.map((cell) => cell.articleId) } }, { _id: 0, id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));
  const events: (FoxEvent & { sort: number })[] = [
    ...hunts.map((hunt) => {
      const time = hunt.huntTime ?? hunt.updatedAt;
      return { sort: time.getTime(), time: time.toISOString(), kind: "hunt" as const, detail: `hunt op jotihunt.nl: ${hunt.status}, ${hunt.points} punten`, latLng: null, rdText: null };
    }),
    ...reports.map((report) => {
      const time = report.huntTime ?? report.takenAt ?? report.createdAt;
      const position = report.location?.coordinates;
      return { sort: time.getTime(), time: time.toISOString(), kind: "hunt-report" as const, detail: `hunt gemeld door ${report.reportedByName}`, ...(position?.length === 2 ? at(position[0], position[1]) : { latLng: null, rdText: null }) };
    }),
    ...cells.map((cell) => ({
      sort: cell.slotTime.getTime(),
      time: cell.slotTime.toISOString(),
      kind: "hint" as const,
      detail: `hint "${titles.get(cell.articleId) ?? cell.articleId}": ${cell.answer ?? ""}`,
      ...(cell.answerLocation?.length === 2 ? at(cell.answerLocation[0], cell.answerLocation[1]) : { latLng: null, rdText: null }),
    })),
  ];
  return {
    area: key,
    events: events
      .sort((a, b) => a.sort - b.sort)
      .slice(-MAX_FOX_EVENTS)
      .map(({ sort: _sort, ...event }) => event),
    prediction: prediction
      ? { status: prediction.status, pin: prediction.pin ?? null, confidence: prediction.confidence ?? null, why: prediction.why ?? "", round: prediction.round ?? 1, updatedAt: prediction.updatedAt.toISOString(), stale: prediction.stale ?? false }
      : null,
  };
}

/** Where our own hunters are (Traccar + Life360), newest fix first */
export async function ourTeams(now: Date) {
  const trackers = await loadTrackers(now);
  return {
    trackers: trackers
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((tracker) => ({ name: tracker.name, source: tracker.source, ...at(tracker.lng, tracker.lat), ageMin: Math.max(0, Math.round((now.getTime() - tracker.at.getTime()) / 60_000)) })),
  };
}
```

Add inside the object returned by `appDataTools`, after `getAreas`:

```ts
    getFoxHistory: tool({
      description: "Geschiedenis van één vossenteam, oud naar nieuw: hunts (jotihunt.nl), onze huntmeldingen met locatie, opgeloste hintpunten, en de laatste AI-voorspelling.",
      inputSchema: jsonSchema<{ area: string }>({ type: "object", properties: { area: { type: "string", enum: [...AREAS] } }, required: ["area"] }),
      execute: ({ area }) => safely("getFoxHistory", () => foxHistory(area)),
    }),
    getOurTeams: tool({
      description: "Waar onze eigen hunters nu zijn (Traccar-trackers en Life360), met hoe oud de positie is in minuten.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: () => safely("getOurTeams", () => ourTeams(ctx.now())),
    }),
```

- [ ] **Step 4: Run the tests, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/tools/fox-history.test.ts && npx --yes bun test src/services/intel-chat/tools/app-data.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 3 pass and 8 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/intel-chat/tools/app-data.ts src/services/intel-chat/tools/fox-history.test.ts
git commit -m "feat(intel-chat): getFoxHistory and getOurTeams tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 11: distance and projectPoint

**Files:**
- Modify: `package.json` / `bun.lock` (add `@turf/destination`), `src/services/intel-chat/geo.ts` (+ test), `src/services/intel-chat/tools/map.ts`, `src/services/prediction/instance.ts`, `src/services/intel-chat/instance.ts`
- Test: `src/services/intel-chat/tools/distance.test.ts`, `src/services/intel-chat/geo.test.ts`

**Interfaces:**
- Consumes: `straightLineSeconds`, `createWalkMinutes` wiring of the prediction.
- Produces: `bearingBetween(a, b): number` (0-360), `projectFrom(from, bearing, metres): LatLng`; `measure(ctx, from, to, walking)` → `{ distanceM, bearingDeg, walkMinutes?, walkEstimate? }`, `project(from, bearing, metres)` → `{ latLng, rd, formatted, insideNl }`; tools `distance`, `projectPoint`; `walkMinutes` exported from `src/services/prediction/instance.ts` and passed to the chat tools by default.

Decision: the chat shares the prediction's `walkMinutes` instance (one ORS daily counter and circuit breaker, so the chat can't eat the prediction's quota unseen). Without ORS a straight-line estimate is returned with `walkEstimate: true`.

- [ ] **Step 1: Add the dependency** (already in `node_modules` through `@turf/circle`, now a direct dependency)

```bash
npx --yes bun add @turf/destination@^7.4.0
```

- [ ] **Step 2: Write the failing tests**

Append to `src/services/intel-chat/geo.test.ts` (and add `bearingBetween`, `projectFrom` to its import from `./geo`):

```ts
describe("projectFrom / bearingBetween", () => {
  test("7.31 km at 262 degrees from HQ (the 2025 'One Ring' hint) lands about 7.2 km west, 1 km south", () => {
    const target = projectFrom(HQ, 262, 7310);
    const hq = toRd(HQ.lng, HQ.lat);
    const rd = toRd(target.lng, target.lat);
    expect(Math.abs(rd.x - hq.x - -7239)).toBeLessThan(100);
    expect(Math.abs(rd.y - hq.y - -1017)).toBeLessThan(100);
    expect(bearingBetween(HQ, target)).toBeCloseTo(262, 0);
  });

  test("bearing is 0-360", () => {
    expect(bearingBetween(HQ, projectFrom(HQ, 350, 1000))).toBeCloseTo(350, 0);
  });
});
```

Create `src/services/intel-chat/tools/distance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mockModel } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { mapTools } from "./map";

const base = { articleId: 1, now: () => new Date(), toolModel: mockModel(() => "") };

describe("distance", () => {
  test("metres and bearing; walking via walkMinutes", async () => {
    const calls: unknown[] = [];
    const tools = mapTools({
      ...base,
      walkMinutes: async (from, to) => {
        calls.push({ from, to });
        return { minutes: [42], estimate: false };
      },
    });
    const result = (await runTool(tools.distance, { from: "188362 440722", to: "188362 441722", walking: true })) as { distanceM: number; bearingDeg: number };
    expect(Math.abs(result.distanceM - 1000)).toBeLessThan(5);
    // RD north is within a degree of true north here
    expect(Math.min(result.bearingDeg, 360 - result.bearingDeg)).toBeLessThan(1);
    expect(result).toMatchObject({ walkMinutes: 42, walkEstimate: false });
    expect(calls).toHaveLength(1);
    expect(await runTool(tools.distance, { from: "188362 440722", to: "188362 441722" })).not.toHaveProperty("walkMinutes");
  });

  test("walking without ORS is a straight-line estimate", async () => {
    const result = (await runTool(mapTools(base).distance, { from: "188362 440722", to: "188362 441722", walking: true })) as { walkMinutes: number; walkEstimate: boolean };
    expect(result.walkEstimate).toBe(true);
    expect(result.walkMinutes).toBeGreaterThan(5);
  });

  test("a bad point names the argument", async () => {
    expect(await runTool(mapTools(base).distance, { from: "x", to: "188362 441722" })).toEqual({ error: 'Kon geen coördinaat lezen uit from "x"' });
  });
});

describe("projectPoint", () => {
  test("from HQ by bearing and distance, all notations", async () => {
    const result = (await runTool(mapTools(base).projectPoint, { from: "188362 440722", bearingDeg: 90, distanceM: 1000 })) as { rd: { x: number; y: number }; formatted: { rd8: string } };
    expect(Math.abs(result.rd.x - 189362)).toBeLessThan(30);
    expect(Math.abs(result.rd.y - 440722)).toBeLessThan(30);
    expect(result.formatted.rd8).toBe("1894 4407");
  });

  test("distance out of range is an error", async () => {
    expect(await runTool(mapTools(base).projectPoint, { from: "188362 440722", bearingDeg: 90, distanceM: 200_000 })).toEqual({ error: "distanceM moet tussen 0 en 100000 liggen" });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx --yes bun test src/services/intel-chat/geo.test.ts` → FAIL (`projectFrom` is not exported); `npx --yes bun test src/services/intel-chat/tools/distance.test.ts` → FAIL (`tools.distance` undefined).

- [ ] **Step 4: Implement the geo helpers** in `src/services/intel-chat/geo.ts`: replace the first import line with

```ts
import destination from "@turf/destination";
import { bearingDeg, distanceM } from "../prediction/geo";
```

and append:

```ts
/** Compass bearing from a to b, 0-360 degrees (0 = north), rounded to 0.1 */
export function bearingBetween(a: LatLng, b: LatLng): number {
  return Math.round(((bearingDeg([a.lng, a.lat], [b.lng, b.lat]) + 360) % 360) * 10) / 10;
}

/** The point `distanceM` metres from `from` in compass direction `bearing` (degrees, 0 = north; great circle) */
export function projectFrom(from: LatLng, bearing: number, metres: number): LatLng {
  const [lng, lat] = destination([from.lng, from.lat], metres, bearing, { units: "meters" }).geometry.coordinates;
  return { lat, lng };
}
```

- [ ] **Step 5: Implement the tools** in `src/services/intel-chat/tools/map.ts`: replace the `../geo` import line with

```ts
import { straightLineSeconds } from "../../prediction/straight-line.router";
import { bearingBetween, coordinateAt, formatCoordinate, groupsWithin, insideNl, metresBetween, parseCoordinate, projectFrom, type ParsedCoordinate } from "../geo";
```

add after `const MAX_NEARBY = 25;`:

```ts
const MAX_PROJECT_M = 100_000;

/** Straight line, bearing and (optionally) walking time between two points */
export async function measure(ctx: IntelToolContext, fromText: string, toText: string, walking: boolean) {
  const from = readPoint(fromText, "from").latLng;
  const to = readPoint(toText, "to").latLng;
  const result: { distanceM: number; bearingDeg: number; walkMinutes?: number; walkEstimate?: boolean } = { distanceM: metresBetween(from, to), bearingDeg: bearingBetween(from, to) };
  if (!walking) return result;
  if (ctx.walkMinutes) {
    const { minutes, estimate } = await ctx.walkMinutes([from.lng, from.lat], [[to.lng, to.lat]]);
    return { ...result, walkMinutes: minutes[0], walkEstimate: estimate };
  }
  return { ...result, walkMinutes: Math.round(straightLineSeconds([from.lng, from.lat], [to.lng, to.lat]) / 60), walkEstimate: true };
}

/** The point at a distance and compass bearing from another (coördinatenprojectie) */
export function project(fromText: string, bearing: number, metres: number) {
  const from = readPoint(fromText, "from").latLng;
  if (!Number.isFinite(bearing)) throw new ToolInputError("bearingDeg moet een getal zijn");
  if (!Number.isFinite(metres) || metres < 0 || metres > MAX_PROJECT_M) throw new ToolInputError("distanceM moet tussen 0 en 100000 liggen");
  const target = coordinateAt(projectFrom(from, ((bearing % 360) + 360) % 360, metres));
  return { latLng: target.latLng, rd: { x: Math.round(target.rd.x), y: Math.round(target.rd.y) }, formatted: formatCoordinate(target), insideNl: insideNl(target.latLng) };
}
```

and add inside the object returned by `mapTools`, after `nearbyGroups`:

```ts
    distance: tool({
      description: "Afstand in meters en kompasrichting (0-360, 0 = noord) tussen twee punten; met walking ook de looptijd in minuten (route te voet, of een schatting).",
      inputSchema: jsonSchema<{ from: string; to: string; walking?: boolean }>({
        type: "object",
        properties: { from: { type: "string", description: POINT_DESCRIPTION }, to: { type: "string", description: POINT_DESCRIPTION }, walking: { type: "boolean", description: "Ook looptijd berekenen" } },
        required: ["from", "to"],
      }),
      execute: ({ from, to, walking }) => safely("distance", () => measure(ctx, from, to, walking === true)),
    }),
    projectPoint: tool({
      description: "Bereken het punt op een afstand en kompasrichting vanaf een ander punt (coördinatenprojectie, bv. '7,31 km op 262 graden vanaf HQ').",
      inputSchema: jsonSchema<{ from: string; bearingDeg: number; distanceM: number }>({
        type: "object",
        properties: {
          from: { type: "string", description: POINT_DESCRIPTION },
          bearingDeg: { type: "number", description: "Kompasrichting in graden, 0 = noord, 90 = oost" },
          distanceM: { type: "number", description: "Afstand in meters (0-100000)" },
        },
        required: ["from", "bearingDeg", "distanceM"],
      }),
      execute: ({ from, bearingDeg, distanceM }) => safely("projectPoint", async () => project(from, Number(bearingDeg), Number(distanceM))),
    }),
```

- [ ] **Step 6: Share the walking router**

In `src/services/prediction/instance.ts` replace the `predictionService` block with:

```ts
/** Walking minutes via ORS (one daily quota and circuit breaker, shared by the prediction and the Intel chat) */
export const walkMinutes = createWalkMinutes({ walking: createOrsRouter(process.env.ORS_API_KEY || undefined), fallback: straightLineRouter });

// Real clients for the running server. Tests build their own service with mocks.
export const predictionService = createPredictionService({
  predictor: models ? createGeminiPredictor({ model: models("prediction") }) : null,
  walkMinutes,
});
```

In `src/services/intel-chat/instance.ts` add `import { walkMinutes } from "../prediction/instance";` after the `createModels` import and initialise `toolDeps` with `{ walkMinutes }`:

```ts
let toolDeps: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">> = { walkMinutes };
```

- [ ] **Step 7: Run the tests, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/geo.test.ts && npx --yes bun test src/services/intel-chat/tools/distance.test.ts && npx --yes bun test src/routes/intel-chat.route.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 16, 5 and 11 pass.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/services/intel-chat/geo.ts src/services/intel-chat/geo.test.ts src/services/intel-chat/tools/map.ts src/services/intel-chat/tools/distance.test.ts src/services/prediction/instance.ts src/services/intel-chat/instance.ts
git commit -m "feat(intel-chat): distance and projectPoint tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 12: geocode and reverseGeocode (PDOK)

**Files:**
- Create: `src/services/intel-chat/pdok.client.ts`
- Modify: `src/services/intel-chat/tools/map.ts`
- Test: `src/services/intel-chat/pdok.client.test.ts`

**Interfaces:**
- Consumes: `ctx.fetch` (tests), `coordinateAt` / `formatCoordinate`, `readPoint`.
- Produces: `PDOK_BASE_URL`, `GeocodeHit { name, type, latLng }`, `ReverseHit { name, type, distanceM }`, `parseWktPoint(value)`, `geocode(query, { fetch?, signal? })`, `reverseGeocode(point, { fetch?, signal? })`; tools `geocode` → `{ results: (GeocodeHit & { rdText })[] }`, `reverseGeocode` → `{ results: ReverseHit[] }`.

Verified live (2026-10-15): `GET https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=…&rows=5&fl=weergavenaam,type,centroide_ll` → `response.docs[].{weergavenaam,type,centroide_ll:"POINT(lng lat)"}`; `GET …/reverse?lat=…&lon=…&rows=5` → `response.docs[].{weergavenaam,type,afstand}`. No key needed.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/pdok.client.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mockModel } from "../../test/ai";
import { runTool } from "../../test/tools";
import { geocode, parseWktPoint, reverseGeocode } from "./pdok.client";
import { mapTools } from "./tools/map";

function fakeFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return Response.json(body, { status });
  };
  return { fetch, urls };
}

const FREE = {
  response: {
    docs: [
      { type: "adres", weergavenaam: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", centroide_ll: "POINT(5.87232125 51.95386777)" },
      { type: "weg", weergavenaam: "zonder punt" },
    ],
  },
};
const REVERSE = { response: { docs: [{ type: "adres", weergavenaam: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", afstand: 14.85 }] } };

describe("PDOK client", () => {
  test("geocode asks /free with the fields we need and skips docs without a point", async () => {
    const { fetch, urls } = fakeFetch(FREE);
    expect(await geocode("Stikkerstraat 10 Arnhem", { fetch })).toEqual([{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", latLng: { lat: 51.95386777, lng: 5.87232125 } }]);
    expect(urls[0]).toBe("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=Stikkerstraat%2010%20Arnhem&rows=5&fl=weergavenaam,type,centroide_ll");
  });

  test("reverseGeocode asks /reverse and rounds the distance", async () => {
    const { fetch, urls } = fakeFetch(REVERSE);
    expect(await reverseGeocode({ lat: 51.95392, lng: 5.87252 }, { fetch })).toEqual([{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", distanceM: 15 }]);
    expect(urls[0]).toBe("https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse?lat=51.953920&lon=5.872520&rows=5");
  });

  test("HTTP errors and network failures become Dutch tool errors", async () => {
    await expect(geocode("x", { fetch: fakeFetch({}, 500).fetch })).rejects.toThrow("PDOK gaf HTTP 500");
    await expect(
      geocode("x", {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toThrow("PDOK niet bereikbaar");
  });

  test("parseWktPoint", () => {
    expect(parseWktPoint("POINT(5.1 52.2)")).toEqual({ lng: 5.1, lat: 52.2 });
    expect(parseWktPoint("LINESTRING(1 2, 3 4)")).toBeNull();
  });
});

describe("geocode / reverseGeocode tools", () => {
  test("geocode adds the 8-digit RD; reverseGeocode takes any point notation", async () => {
    const tools = mapTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), fetch: fakeFetch(FREE).fetch });
    expect(await runTool(tools.geocode, { query: "Stikkerstraat 10 Arnhem" })).toEqual({ results: [{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", latLng: { lat: 51.95386777, lng: 5.87232125 }, rdText: "1883 4407" }] });
    const reverse = mapTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), fetch: fakeFetch(REVERSE).fetch });
    expect(await runTool(reverse.reverseGeocode, { point: "188362 440722" })).toEqual({ results: [{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", distanceM: 15 }] });
    expect(await runTool(reverse.geocode, { query: "" })).toEqual({ error: "Zoekterm moet 1 tot 200 tekens zijn" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/pdok.client.test.ts`
Expected: FAIL (cannot find module `./pdok.client`).

- [ ] **Step 3: Implement** `src/services/intel-chat/pdok.client.ts`

```ts
import { ToolInputError } from "./tools/context";
import type { LatLng } from "./geo";

/** PDOK Locatieserver (Dutch addresses, streets, places, postcodes; no key, NL only) */
export const PDOK_BASE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
export const PDOK_TIMEOUT_MS = 10_000;
const ROWS = 5;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GeocodeHit {
  name: string;
  type: string;
  latLng: LatLng;
}

export interface ReverseHit {
  name: string;
  type: string;
  distanceM: number;
}

async function pdokDocs(fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PDOK_TIMEOUT_MS)]) : AbortSignal.timeout(PDOK_TIMEOUT_MS) });
  } catch {
    throw new ToolInputError("PDOK niet bereikbaar");
  }
  if (!response.ok) throw new ToolInputError(`PDOK gaf HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { response?: { docs?: unknown } } | null;
  const docs = body?.response?.docs;
  return Array.isArray(docs) ? docs.filter((doc): doc is Record<string, unknown> => typeof doc === "object" && doc !== null) : [];
}

/** "POINT(5.87 51.95)" → { lat, lng } */
export function parseWktPoint(value: unknown): LatLng | null {
  const match = typeof value === "string" ? /^POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(value) : null;
  return match ? { lng: Number(match[1]), lat: Number(match[2]) } : null;
}

/** Up to 5 places for a free-text query (address, street, place, postcode) */
export async function geocode(query: string, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<GeocodeHit[]> {
  const q = String(query ?? "").trim();
  if (!q || q.length > 200) throw new ToolInputError("Zoekterm moet 1 tot 200 tekens zijn");
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/free?q=${encodeURIComponent(q)}&rows=${ROWS}&fl=weergavenaam,type,centroide_ll`, signal);
  return docs.flatMap((doc) => {
    const latLng = parseWktPoint(doc.centroide_ll);
    return latLng && typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), latLng }] : [];
  });
}

/** Up to 5 addresses nearest to a point, nearest first */
export async function reverseGeocode(point: LatLng, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<ReverseHit[]> {
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/reverse?lat=${point.lat.toFixed(6)}&lon=${point.lng.toFixed(6)}&rows=${ROWS}`, signal);
  return docs.flatMap((doc) => (typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), distanceM: Math.round(Number(doc.afstand) || 0) }] : []));
}
```

- [ ] **Step 4: Add the tools** in `src/services/intel-chat/tools/map.ts`: add the import after the `../geo` import

```ts
import { geocode, reverseGeocode } from "../pdok.client";
```

and add inside the object returned by `mapTools`, after `projectPoint`:

```ts
    geocode: tool({
      description: "Zoek een adres, straat, plaats of postcode in Nederland (PDOK). Geeft max 5 treffers met coördinaten.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Bijvoorbeeld 'Stikkerstraat 10 Arnhem' of '6842CW'" } }, required: ["query"] }),
      execute: ({ query }, { abortSignal }) =>
        safely("geocode", async () => ({
          results: (await geocode(query, { fetch: ctx.fetch, signal: abortSignal })).map((hit) => ({ ...hit, rdText: formatCoordinate(coordinateAt(hit.latLng)).rd8 })),
        })),
    }),
    reverseGeocode: tool({
      description: "De dichtstbijzijnde adressen bij een punt in Nederland (PDOK), met afstand in meters.",
      inputSchema: jsonSchema<{ point: string }>({ type: "object", properties: { point: { type: "string", description: POINT_DESCRIPTION } }, required: ["point"] }),
      execute: ({ point }, { abortSignal }) => safely("reverseGeocode", async () => ({ results: await reverseGeocode(readPoint(point).latLng, { fetch: ctx.fetch, signal: abortSignal }) })),
    }),
```

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/pdok.client.test.ts && npx --yes bun test src/services/intel-chat/tools/map.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 5 and 10 pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/intel-chat/pdok.client.ts src/services/intel-chat/pdok.client.test.ts src/services/intel-chat/tools/map.ts
git commit -m "feat(intel-chat): geocode and reverseGeocode via PDOK" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 13: readWebPage with SSRF guard

**Files:**
- Modify: `src/services/article-media.ts` (export `readCapped`), `src/services/intel-chat/tools/web.ts`
- Create: `src/services/intel-chat/web-fetch.ts`
- Test: `src/services/intel-chat/web-fetch.test.ts`

**Interfaces:**
- Consumes: `readCapped`, `htmlToText`, `ctx.fetch`, `ctx.lookup`.
- Produces: `isPrivateAddress(ip)`, `assertPublicUrl(url, lookup?)`, `WebPage { url, title, text, truncated }`, `readWebPage(url, { fetch?, lookup?, signal? })`; tool `readWebPage` (in `WEB_TOOL_NAMES`, so only active with Web on).

Rules: http(s) only, no credentials in the URL, every resolved address of the host must be public (IPv4 private/loopback/link-local/CGNAT/multicast/reserved, IPv6 loopback/ULA/link-local/multicast, IPv4-mapped), redirects followed by hand (max 3) with the same check per hop, 10 s, 1 MB, text types only (`text/html`, `application/xhtml+xml`, `text/plain`, `application/json`), 20 000 chars. Known limit: the check resolves DNS separately from `fetch` (a rebinding host could still switch addresses in between); acceptable for a read-only text fetch.

- [ ] **Step 1: Export `readCapped`** in `src/services/article-media.ts`: change `async function readCapped(` to `export async function readCapped(`.

- [ ] **Step 2: Write the failing test** `src/services/intel-chat/web-fetch.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { mockModel } from "../../test/ai";
import { runTool } from "../../test/tools";
import { webTools } from "./tools/web";
import { assertPublicUrl, isPrivateAddress, readWebPage } from "./web-fetch";

const publicDns = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    expect(init.redirect).toBe("manual");
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
  return { fetch, urls };
}
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("isPrivateAddress", () => {
  test("private, loopback, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "nonsense"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  test("public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  test("refuses other schemes, credentials, private IP literals and hosts resolving to a private address", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", publicDns)).rejects.toThrow("Alleen http(s)-adressen");
    await expect(assertPublicUrl("ftp://example.org/x", publicDns)).rejects.toThrow("Alleen http(s)-adressen");
    await expect(assertPublicUrl("http://user:pw@example.org/", publicDns)).rejects.toThrow("Geen URL's met inloggegevens");
    await expect(assertPublicUrl("http://127.0.0.1:27017/", publicDns)).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://[::1]/", publicDns)).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://intern.example/", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://weg.example/", async () => Promise.reject(new Error("ENOTFOUND")))).rejects.toThrow("Kan weg.example niet vinden");
    expect((await assertPublicUrl("https://example.org/a", publicDns)).hostname).toBe("example.org");
  });
});

describe("readWebPage", () => {
  test("html becomes text with the title", async () => {
    const { fetch } = fakeFetch({ "https://example.org/a": () => html("<html><head><title> Brave </title></head><body><p>Merida</p><script>x()</script></body></html>") });
    expect(await readWebPage("https://example.org/a", { fetch, lookup: publicDns })).toEqual({ url: "https://example.org/a", title: "Brave", text: "Brave Merida", truncated: false });
  });

  test("follows a public redirect, refuses a redirect to a private host", async () => {
    const lookup = async (host: string) => (host === "evil.example" ? ["192.168.1.10"] : ["93.184.216.34"]);
    const { fetch } = fakeFetch({
      "https://example.org/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://example.org/new": () => html("<p>nieuw</p>"),
      "https://example.org/bad": () => new Response(null, { status: 302, headers: { location: "http://evil.example/admin" } }),
    });
    expect((await readWebPage("https://example.org/old", { fetch, lookup })).text).toBe("nieuw");
    await expect(readWebPage("https://example.org/bad", { fetch, lookup })).rejects.toThrow("niet toegestaan");
  });

  test("non-text types, errors, too large and long pages", async () => {
    const { fetch } = fakeFetch({
      "https://example.org/img": () => new Response("x", { headers: { "content-type": "image/png" } }),
      "https://example.org/404": () => new Response("nope", { status: 404 }),
      "https://example.org/big": () => new Response("a".repeat(1024 * 1024 + 1), { headers: { "content-type": "text/plain" } }),
      "https://example.org/long": () => new Response("b".repeat(25_000), { headers: { "content-type": "text/plain" } }),
    });
    await expect(readWebPage("https://example.org/img", { fetch, lookup: publicDns })).rejects.toThrow("Geen tekstpagina (image/png)");
    await expect(readWebPage("https://example.org/404", { fetch, lookup: publicDns })).rejects.toThrow("Pagina gaf HTTP 404");
    await expect(readWebPage("https://example.org/big", { fetch, lookup: publicDns })).rejects.toThrow("groter dan 1 MB");
    await expect(readWebPage("https://example.org/down", { fetch, lookup: publicDns })).rejects.toThrow("Pagina niet bereikbaar");
    const long = await readWebPage("https://example.org/long", { fetch, lookup: publicDns });
    expect(long.text).toHaveLength(20_000);
    expect(long.truncated).toBe(true);
  });

  test("the readWebPage tool returns { error } for a refused URL", async () => {
    const tools = webTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), lookup: async () => ["127.0.0.1"], fetch: fakeFetch({}).fetch });
    expect(await runTool(tools.readWebPage, { url: "http://localhost:3000/admin" })).toEqual({ error: "Dit adres is niet toegestaan (intern netwerk)" });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/web-fetch.test.ts`
Expected: FAIL (cannot find module `./web-fetch`).

- [ ] **Step 4: Implement** `src/services/intel-chat/web-fetch.ts`

```ts
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readCapped } from "../article-media";
import { htmlToText } from "../html-text";
import { ToolInputError } from "./tools/context";

export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_MAX_BYTES = 1024 * 1024;
export const PAGE_MAX_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Lookup = (hostname: string) => Promise<string[]>;

const ipv4Number = (ip: string) => ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
const inV4 = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4Number(ip) & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0);
};
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Loopback, private, link-local, CGNAT, multicast, reserved or unspecified (IPv4, IPv6 and IPv4-mapped IPv6) */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) return PRIVATE_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (isIP(ip) !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (ip === "::" || ip === "::1") return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

const systemLookup: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/** The URL when it is http(s) on a host whose every address is public; ToolInputError otherwise */
export async function assertPublicUrl(raw: string, lookup: Lookup = systemLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError("Ongeldige URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolInputError("Alleen http(s)-adressen");
  if (url.username || url.password) throw new ToolInputError("Geen URL's met inloggegevens");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    throw new ToolInputError(`Kan ${host} niet vinden`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new ToolInputError("Dit adres is niet toegestaan (intern netwerk)");
  return url;
}

export interface WebPage {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

/**
 * Read a public web page as plain text: http(s) only, every hop (redirects followed by hand, max 3) checked against
 * private addresses, 10 s, 1 MB, text types only, at most 20 000 characters.
 */
export async function readWebPage(raw: string, { fetch: fetchFn = fetch, lookup = systemLookup, signal }: { fetch?: Fetch; lookup?: Lookup; signal?: AbortSignal } = {}): Promise<WebPage> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(PAGE_TIMEOUT_MS);
  let url = await assertPublicUrl(raw, lookup);
  let response: Response;
  try {
    response = await fetchFn(url.toString(), { redirect: "manual", signal: deadline, headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "JotihuntTracker/1.0 (intel chat)" } });
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) throw new ToolInputError("Te veel of ongeldige doorverwijzingen");
      url = await assertPublicUrl(new URL(location, url).toString(), lookup);
      response = await fetchFn(url.toString(), { redirect: "manual", signal: deadline, headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "JotihuntTracker/1.0 (intel chat)" } });
    }
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError("Pagina niet bereikbaar");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`Pagina gaf HTTP ${response.status}`);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TEXT_TYPES.includes(type)) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`Geen tekstpagina (${type || "onbekend type"})`);
  }
  const data = await readCapped(response, PAGE_MAX_BYTES).catch(() => null);
  if (!data) throw new ToolInputError("Pagina is groter dan 1 MB of brak af");
  const body = new TextDecoder().decode(data);
  const isHtml = type === "text/html" || type === "application/xhtml+xml";
  const title = isHtml ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "").replace(/\s+/g, " ").trim() || null : null;
  const text = isHtml ? htmlToText(body) : body.trim();
  return { url: url.toString(), title, text: text.slice(0, PAGE_MAX_CHARS), truncated: text.length > PAGE_MAX_CHARS };
}
```

- [ ] **Step 5: Add the tool** in `src/services/intel-chat/tools/web.ts`: add `import { readWebPage } from "../web-fetch";` before the `./context` import and add inside the object returned by `webTools`, after `webSearch`:

```ts
    readWebPage: tool({
      description: "Lees een openbare webpagina als platte tekst (max 20 000 tekens), bv. een bron uit webSearch of een link uit een hint.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "http(s)-adres" } }, required: ["url"] }),
      execute: ({ url }, { abortSignal }) => safely("readWebPage", () => readWebPage(url, { fetch: ctx.fetch, lookup: ctx.lookup, signal: abortSignal })),
    }),
```

- [ ] **Step 6: Run the tests, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/web-fetch.test.ts && npx --yes bun test src/services/intel-chat/tools/web.test.ts && npx --yes bun test src/services/article-media.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: all pass (7 + 3 + the existing article-media tests).

- [ ] **Step 7: Commit**

```bash
git add src/services/article-media.ts src/services/intel-chat/web-fetch.ts src/services/intel-chat/web-fetch.test.ts src/services/intel-chat/tools/web.ts
git commit -m "feat(intel-chat): readWebPage with private address guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 14: runCode

**Files:**
- Create: `src/services/intel-chat/tools/puzzle.ts`
- Modify: `src/services/intel-chat/tools/index.ts`
- Test: `src/services/intel-chat/tools/puzzle.test.ts`

**Interfaces:**
- Produces: `RunCodeResult { answer, code: string | null, output: string | null }`, `runCode(model, task, abortSignal?)`, `puzzleTools(ctx)` → `{ runCode }`; registered in `createIntelTools`.

Verified against @ai-sdk/google 4.0.87: `tools: { code_execution: google.tools.codeExecution({}) }` sends `tools: [{ codeExecution: {} }]`; the answer's `executableCode` / `codeExecutionResult` parts come back in `result.content` as a provider-executed `tool-call` (`input.code`) and `tool-result` (`output.output`) named `code_execution`.

- [ ] **Step 1: Write the failing test** `src/services/intel-chat/tools/puzzle.test.ts`

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { localGoogle } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { puzzleTools } from "./puzzle";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("runCode", () => {
  test("asks Gemini with code execution and returns answer, code and output", async () => {
    const bodies: Record<string, unknown>[] = [];
    const google = localGoogle(async (request) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ executableCode: { language: "PYTHON", code: "print(sum(map(int, '2126')))" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "11\n" } }, { text: "De cijfersom is 11." }] },
            finishReason: "STOP",
          },
        ],
      });
    });
    stop = google.stop;
    const tools = puzzleTools({ articleId: 1, now: () => new Date(), toolModel: google.model("gemini-test") });
    expect(await runTool(tools.runCode, { task: "cijfersom van 2126" })).toEqual({ answer: "De cijfersom is 11.", code: "print(sum(map(int, '2126')))", output: "11\n" });
    expect(bodies[0].tools).toEqual([{ codeExecution: {} }]);
  });

  test("an empty task is refused", async () => {
    const google = localGoogle(() => Response.json({}));
    stop = google.stop;
    expect(await runTool(puzzleTools({ articleId: 1, now: () => new Date(), toolModel: google.model("x") }).runCode, { task: " " })).toEqual({ error: "Taak moet 1 tot 4000 tekens zijn" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx --yes bun test src/services/intel-chat/tools/puzzle.test.ts`
Expected: FAIL (cannot find module `./puzzle`).

- [ ] **Step 3: Implement** `src/services/intel-chat/tools/puzzle.ts`

```ts
import { google } from "@ai-sdk/google";
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { toGeminiError } from "../../ai/gemini-error";
import { safely, ToolInputError, type IntelToolContext } from "./context";

export const RUN_CODE_TIMEOUT_MS = 60_000;
const MAX_TASK = 4000;
const MAX_OUTPUT = 4000;

export interface RunCodeResult {
  answer: string;
  code: string | null;
  output: string | null;
}

/**
 * Let Gemini write and run Python for a precise task (ciphers, counting, arithmetic) in its own sub-call with the
 * built-in code execution tool. Returns its answer plus the last code it ran and that code's output.
 */
export async function runCode(model: LanguageModel, task: string, abortSignal?: AbortSignal): Promise<RunCodeResult> {
  const text = String(task ?? "").trim();
  if (!text || text.length > MAX_TASK) throw new ToolInputError("Taak moet 1 tot 4000 tekens zijn");
  try {
    const result = await generateText({
      model,
      instructions: "Los deze taak op door Python-code te schrijven en uit te voeren. Geef daarna kort het resultaat in het Nederlands. Reken nooit uit je hoofd.",
      prompt: text,
      tools: { code_execution: google.tools.codeExecution({}) },
      maxRetries: 0,
      timeout: RUN_CODE_TIMEOUT_MS,
      abortSignal,
    });
    let code: string | null = null;
    let output: string | null = null;
    for (const part of result.content) {
      if (part.type === "tool-call" && part.toolName === "code_execution") code = String((part.input as { code?: unknown })?.code ?? "") || null;
      if (part.type === "tool-result" && part.toolName === "code_execution") output = String((part.output as { output?: unknown })?.output ?? "") || null;
    }
    return { answer: result.text.trim().slice(0, MAX_OUTPUT), code: code?.slice(0, MAX_OUTPUT) ?? null, output: output?.slice(0, MAX_OUTPUT) ?? null };
  } catch (error) {
    throw toGeminiError(error);
  }
}

export function puzzleTools(ctx: IntelToolContext) {
  return {
    runCode: tool({
      description: "Laat een precieze rekentaak uitvoeren met Python: ciphers decoderen (Caesar met alle shifts, binair, morse-tabellen), letters tellen, stapeltellen, rekenwerk. Beschrijf de taak volledig met alle invoer.",
      inputSchema: jsonSchema<{ task: string }>({ type: "object", properties: { task: { type: "string", description: "De volledige taak met alle gegevens" } }, required: ["task"] }),
      execute: ({ task }, { abortSignal }) => safely("runCode", () => runCode(ctx.toolModel, task, abortSignal)),
    }),
  };
}
```

- [ ] **Step 4: Register it** in `src/services/intel-chat/tools/index.ts`; the file becomes:

```ts
import { appDataTools } from "./app-data";
import type { IntelToolContext } from "./context";
import { mapTools } from "./map";
import { proposalTools } from "./proposals";
import { puzzleTools } from "./puzzle";
import { WEB_TOOL_NAMES, webTools } from "./web";

export type { IntelToolContext } from "./context";

/** Every tool of the Intel chat; names are binding for the client (UI part type `tool-<name>`) */
export function createIntelTools(ctx: IntelToolContext) {
  return { ...appDataTools(ctx), ...mapTools(ctx), ...proposalTools(ctx), ...webTools(ctx), ...puzzleTools(ctx) };
}

export type IntelTools = ReturnType<typeof createIntelTools>;

/** The tools the model may call this turn: the web tools only with "Web" on */
export function activeToolNames(tools: IntelTools, web: boolean): (keyof IntelTools)[] {
  return (Object.keys(tools) as (keyof IntelTools)[]).filter((name) => web || !(WEB_TOOL_NAMES as readonly string[]).includes(name));
}
```

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npx --yes bun test src/services/intel-chat/tools/puzzle.test.ts && npx --yes bun test src/services/intel-chat/agent.test.ts && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: 2 and 3 pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/intel-chat/tools/puzzle.ts src/services/intel-chat/tools/puzzle.test.ts src/services/intel-chat/tools/index.ts
git commit -m "feat(intel-chat): runCode via Gemini code execution" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 15: Final verification

**Files:** none (fixes only if something fails).

- [ ] **Step 1: Full suite, typecheck, lint**

Run: `npx --yes bun test --timeout 30000 && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: all pass, tsc and eslint clean (rerun `src/demo` alone if a known load-flaky switch timeout appears).

- [ ] **Step 2: Tool list check**: every contract tool name is registered.

Run: `grep -ohE "^    [a-zA-Z]+: tool\(" src/services/intel-chat/tools/*.ts | sort`
Expected (18): `checkPoint, convertCoordinates, distance, geocode, getAreas, getFoxHistory, getHintBoard, getItem, getOurTeams, nearbyGroups, projectPoint, proposeHintAnswer, readWebPage, reverseGeocode, runCode, searchIntel, showPoint, webSearch`.

- [ ] **Step 3: Optional smoke test against real Gemini** (needs a key; never print or commit it): start a throwaway server (`.stress/start-server.sh` in the client repo, or `GEMINI_API_KEY=… npx --yes bun run start` against a scratch database), sign in, then `curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":{"id":"t1","role":"user","parts":[{"type":"text","text":"Zet 188362 440722 om en laat het punt zien"}]},"web":false,"deep":false}' http://localhost:3000/intel-chat/<hint id>` and check the SSE shows `tool-convertCoordinates` / `tool-showPoint` parts and text; `GET` the chat afterwards.

- [ ] **Step 4: Leave the branch** `feat/intel-ai-chat` unmerged and undeployed; report the commit list.
