# Hint Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared `/hints` board where HQ solvers claim per-area hint cells, add notes, enter answers, and RD-coordinate answers instantly become hint markers on the map.

**Architecture:** Server gets a `HintCell` collection (one per Jotihunt hint article × area), created by the articles cron (which switches from delete+insert to upsert). Pure helpers (`hint-parser`, `rd-answer`) and a mongoose-only service (`hint-board.service`) hold all logic and are tested with `bun test` against the local Docker MongoDB; a thin Express controller exposes it. Client polls `/hints/board` every 3 s via the existing SWR helper and renders a laptop-first grid + side panel.

**Tech Stack:** Bun 1.4, Express 5, Mongoose 9, express-validator 7, proj4 2.22 (server); React 19, Vite 8, SWR 2, Tailwind 4 + shadcn/ui, DOMPurify 3, use-sound (client).

**Spec:** `docs/superpowers/specs/2026-09-27-hint-board-design.md`

## Global Constraints

- Repos: `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server` and `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`, branch `feat/hint-board` in both (already checked out). Do not push.
- Bun is **not installed on the host**. Every `bun` command below means this shell function (define it in each shell session; run from the repo root you are working in):
  ```bash
  bun_() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network jotihunt_default \
    -e MONGO_URI_TEST=mongodb://mongodb:27017/jotihunt-test \
    -v "$PWD":/app -w /app oven/bun:1 bun "$@"; }
  ```
  Requires the local stack network: `cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d mongodb`.
- Area names are **lowercase** everywhere in cells and markers (`alpha` … `hotel`, `oscar`), matching the existing `Marker.area` values and client `areaOptions`.
- Hint scoring window: 20 minutes from `publishAt`.
- RD bounds (same as `HintEntryCard`): `0 ≤ x ≤ 290000`, `290000 ≤ y ≤ 630000`. 4-digit halves are ×100.
- RD proj4 definition (identical on server and client):
  `+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs`
- Server files under `src/services/` and `src/models/` must **not** import `logger` from `".."` (that import boots the whole server). Only controllers/crons may.
- Client UI copy is Dutch (matches existing app).
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Deviations from spec, decided here: (1) client applies the server's response to the SWR cache immediately instead of a pre-request optimistic update — same UX locally, no rollback logic; (2) service-level tests replace HTTP controller tests (controller is a thin wrapper, verified by a curl smoke test); (3) there is no existing sound setting, so the new-hint sound always plays.

## File Structure

Server (`jotihunt-tracker-server/`):
- Create `src/services/hint-parser.ts` — split hint HTML into per-area snippets.
- Create `src/services/rd-answer.ts` — parse/validate RD answer, convert to WGS84.
- Create `src/models/hint-cell.model.ts` — `HintCell` schema + enums.
- Modify `src/models/article.model.ts` — add `contentHash`, unique `id`.
- Create `src/services/article-sync.service.ts` — upsert articles, create cells, flag edits.
- Modify `src/crons/jotihunt-articles.cron.ts` — delegate to `syncArticles`.
- Create `src/services/hint-board.service.ts` — board read + claim/release/solve/check/note/status.
- Create `src/controllers/hints.controller.ts`, `src/routes/hints.route.ts`; modify `src/index.ts`.
- Create `src/scripts/seed-hint.ts`; modify `package.json` (scripts, `proj4`).
- Create `src/test/db.ts` + `*.test.ts` next to services.

Client (`jotihunt-tracker-client/`):
- Create `src/types/HintCell.ts`, `src/lib/rd-answer.ts`, `src/lib/hints.ts`, `src/hooks/hints.hook.ts`.
- Create `src/components/hints/HintGrid.tsx`, `src/components/hints/HintCellPanel.tsx`, `src/pages/Hints.tsx`.
- Modify `src/Routes.tsx`, `src/components/Settings.tsx`, `tsconfig.app.json`, `package.json`.

---

### Task 1: Hint HTML parser (server)

**Files:**
- Create: `src/services/hint-parser.ts`
- Test: `src/services/hint-parser.test.ts`
- Modify: `package.json` (add `"test": "bun test"` to `scripts`)

**Interfaces:**
- Produces: `DEFAULT_AREAS: string[]`, `interface ParsedAreaHint { snippet: string | null; none: boolean }`, `parseHintArticle(html: string, areaNames?: string[]): Record<string, ParsedAreaHint>` (keys lowercase).

- [ ] **Step 1: Add test script**

In `package.json` `scripts`, add `"test": "bun test",` after `"lint"`.

- [ ] **Step 2: Write the failing test** — `src/services/hint-parser.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_AREAS, parseHintArticle } from "./hint-parser";

const sample =
  `<div><strong>Hint 14:00</strong><br>Merida schiet haar pijlen...<br>` +
  `Alpha: <img src="https://cdn.jotihunt.net/a.png"><br>` +
  `Bravo: -<br>` +
  `Charlie: tweeduizend honderdzesentwintig<br>` +
  `Delta:&nbsp;--<br>` +
  `Echo: <img src="https://cdn.jotihunt.net/e.png"></div>`;

describe("parseHintArticle", () => {
  test("returns an entry for every area", () => {
    const result = parseHintArticle(sample);
    expect(Object.keys(result).sort()).toEqual([...DEFAULT_AREAS].sort());
  });

  test("extracts image snippets", () => {
    const result = parseHintArticle(sample);
    expect(result.alpha.none).toBe(false);
    expect(result.alpha.snippet).toContain("a.png");
    expect(result.alpha.snippet).not.toContain("Bravo");
    expect(result.echo.snippet).toContain("e.png");
  });

  test("extracts text snippets", () => {
    expect(parseHintArticle(sample).charlie.snippet).toContain("tweeduizend honderdzesentwintig");
  });

  test("marks dash-only areas as none", () => {
    const result = parseHintArticle(sample);
    expect(result.bravo).toEqual({ snippet: null, none: true });
    expect(result.delta).toEqual({ snippet: null, none: true });
  });

  test("areas not present get a null snippet", () => {
    expect(parseHintArticle(sample).foxtrot).toEqual({ snippet: null, none: false });
  });

  test("image-only article (2025 style) yields no snippets", () => {
    const html =
      `<div><figure data-trix-attachment="{&quot;filename&quot;:&quot;Hint Oscar.png&quot;}">` +
      `<img src="https://cdn.jotihunt.net/NEL.png"></figure></div>`;
    const result = parseHintArticle(html);
    for (const area of DEFAULT_AREAS) expect(result[area]).toEqual({ snippet: null, none: false });
  });

  test("is case-insensitive", () => {
    const result = parseHintArticle("<div>alpha: 1234 5678<br>BRAVO: -</div>");
    expect(result.alpha.snippet).toContain("1234 5678");
    expect(result.bravo.none).toBe(true);
  });

  test("respects custom area names", () => {
    const result = parseHintArticle(sample, ["Alpha", "Bravo"]);
    expect(Object.keys(result)).toEqual(["alpha", "bravo"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun_ test src/services/hint-parser.test.ts`
Expected: FAIL — `Cannot find module './hint-parser'`.

- [ ] **Step 4: Implement** — `src/services/hint-parser.ts`

```ts
export const DEFAULT_AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"];

export interface ParsedAreaHint {
  snippet: string | null;
  none: boolean;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPlainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a Jotihunt hint article into per-area parts.
 * Hint articles contain lines like "Alpha: <img>", "Bravo: -". A dash-only part means
 * the area has no hint this round. Areas that can't be found get a null snippet, so the
 * client falls back to showing the full article.
 * @param html The article HTML content
 * @param areaNames The area names to look for (case-insensitive)
 * @returns A record keyed by lowercase area name
 */
export function parseHintArticle(html: string, areaNames: string[] = DEFAULT_AREAS): Record<string, ParsedAreaHint> {
  const names = areaNames.map((name) => name.toLowerCase());
  const result: Record<string, ParsedAreaHint> = {};
  for (const name of names) result[name] = { snippet: null, none: false };

  // An area label must follow a tag, whitespace or the start, so names inside attributes don't match
  const pattern = new RegExp(`(^|>|\\s|&nbsp;)(${names.map(escapeRegExp).join("|")})(?:\\s|&nbsp;)*:`, "gi");
  const matches: { area: string; start: number; end: number }[] = [];
  for (const match of html.matchAll(pattern)) {
    const area = match[2].toLowerCase();
    if (matches.some((existing) => existing.area === area)) continue;
    matches.push({ area, start: match.index + match[1].length, end: match.index + match[0].length });
  }

  matches.forEach((match, index) => {
    const raw = html.slice(match.end, matches[index + 1]?.start ?? html.length);
    const text = toPlainText(raw);
    const hasMedia = /<(img|figure|a)\b/i.test(raw);
    if (!hasMedia && /^[-–—\s]+$/.test(text)) {
      result[match.area] = { snippet: null, none: true };
    } else if (hasMedia || text !== "") {
      result[match.area] = { snippet: raw.trim(), none: false };
    }
  });

  return result;
}
```

- [ ] **Step 5: Run tests** — `bun_ test src/services/hint-parser.test.ts` → all PASS. Then `bun_ run typecheck` and `bun_ run lint` → no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json src/services/hint-parser.ts src/services/hint-parser.test.ts
git commit -m "feat(hints): add hint article parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: RD answer parser (server)

**Files:**
- Create: `src/services/rd-answer.ts`
- Test: `src/services/rd-answer.test.ts`
- Modify: `package.json`, `bun.lock` (add `proj4`)

**Interfaces:**
- Produces: `interface RdAnswer { x: number; y: number; lng: number; lat: number }`, `parseRdAnswer(text: string): RdAnswer | null`.

- [ ] **Step 1: Add dependency** — `bun_ add proj4` (ships its own types).

- [ ] **Step 2: Write the failing test** — `src/services/rd-answer.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { parseRdAnswer } from "./rd-answer";

describe("parseRdAnswer", () => {
  test("parses 4+4 digits and converts to WGS84", () => {
    const result = parseRdAnswer("2126 4692");
    expect(result).not.toBeNull();
    expect(result!.x).toBe(212600);
    expect(result!.y).toBe(469200);
    expect(result!.lat).toBeCloseTo(52.2079, 3);
    expect(result!.lng).toBeCloseTo(6.2299, 3);
  });

  test.each([["21264692"], [" 2126   4692 "], ["2126,4692"], ["2126;4692"], ["212600 469200"], ["212600469200"]])(
    "accepts format %p",
    (input) => {
      const result = parseRdAnswer(input);
      expect(result?.x).toBe(212600);
      expect(result?.y).toBe(469200);
    },
  );

  test.each([["doedelzak"], ["12 34"], ["1234 5678 9"], ["2126 469200"], ["0000 0000"], ["2950 4692"], ["2126 6400"], [""]])(
    "rejects %p",
    (input) => {
      expect(parseRdAnswer(input)).toBeNull();
    },
  );
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun_ test src/services/rd-answer.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement** — `src/services/rd-answer.ts`

```ts
import proj4 from "proj4";

proj4.defs(
  "RD",
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs",
);

export interface RdAnswer {
  x: number;
  y: number;
  lng: number;
  lat: number;
}

/**
 * Parse a hint answer as an RD coordinate.
 * Accepts "1234 5678", "12345678", "123400 567800" and "123400567800" (separators: whitespace , ;).
 * @param text The answer as entered
 * @returns The RD and WGS84 coordinates, or null if the text is not a valid RD coordinate
 */
export function parseRdAnswer(text: string): RdAnswer | null {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  let xs: string;
  let ys: string;

  if (parts.length === 1 && /^(\d{8}|\d{12})$/.test(parts[0])) {
    const half = parts[0].length / 2;
    xs = parts[0].slice(0, half);
    ys = parts[0].slice(half);
  } else if (parts.length === 2 && parts[0].length === parts[1].length && parts.every((part) => /^(\d{4}|\d{6})$/.test(part))) {
    [xs, ys] = parts;
  } else {
    return null;
  }

  const x = xs.length === 4 ? Number(xs) * 100 : Number(xs);
  const y = ys.length === 4 ? Number(ys) * 100 : Number(ys);
  if (x < 0 || x > 290000 || y < 290000 || y > 630000) return null;

  const [lng, lat] = proj4("RD", "WGS84", [x, y]);
  return { x, y, lng, lat };
}
```

- [ ] **Step 5: Run tests** — `bun_ test src/services/rd-answer.test.ts` → PASS; `bun_ run typecheck`, `bun_ run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/services/rd-answer.ts src/services/rd-answer.test.ts
git commit -m "feat(hints): add RD answer parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: HintCell model + article sync (server)

**Files:**
- Create: `src/models/hint-cell.model.ts`, `src/services/article-sync.service.ts`, `src/test/db.ts`
- Modify: `src/models/article.model.ts`, `src/crons/jotihunt-articles.cron.ts`
- Test: `src/services/article-sync.service.test.ts`

**Interfaces:**
- Consumes: `parseHintArticle`, `DEFAULT_AREAS` (Task 1); `ApiArticle` from `src/types/api.ts`.
- Produces:
  - `enum HintCellStatus { Open = "open", Solving = "solving", Solved = "solved", None = "none" }`
  - `enum HintCheck { Unchecked = "unchecked", Verified = "verified", Disputed = "disputed" }`
  - `HintCell` mongoose model (fields per spec; `area` lowercase).
  - `floorToHour(date: Date): Date`, `ensureHintCells(article: { id: number; publishAt: Date; content: string }): Promise<number>`, `syncArticles(apiArticles: ApiArticle[]): Promise<{ upserted: number; changedHints: number[]; cellsCreated: number }>`
  - Test helpers `connectTestDb(): Promise<void>`, `clearTestDb(): Promise<void>`, `disconnectTestDb(): Promise<void>`.

- [ ] **Step 1: Create the model** — `src/models/hint-cell.model.ts`

```ts
import mongoose from "mongoose";

export enum HintCellStatus {
  Open = "open",
  Solving = "solving",
  Solved = "solved",
  None = "none",
}

export enum HintCheck {
  Unchecked = "unchecked",
  Verified = "verified",
  Disputed = "disputed",
}

const NoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

const HintCellSchema = new mongoose.Schema({
  articleId: { type: Number, required: true },
  area: { type: String, required: true },
  publishAt: { type: Date, required: true },
  slotTime: { type: Date, required: true },
  snippet: { type: String },
  status: { type: String, enum: Object.values(HintCellStatus), default: HintCellStatus.Open, required: true },
  claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  claimedAt: { type: Date },
  answer: { type: String },
  answerKind: { type: String, enum: ["rd", "text"] },
  markerId: { type: mongoose.Schema.Types.ObjectId, ref: "Marker" },
  check: { type: String, enum: Object.values(HintCheck), default: HintCheck.Unchecked, required: true },
  checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  notes: { type: [NoteSchema], default: [] },
  articleChanged: { type: Boolean, default: false, required: true },
});

HintCellSchema.index({ articleId: 1, area: 1 }, { unique: true });

export const HintCell = mongoose.model("HintCell", HintCellSchema);
```

- [ ] **Step 2: Update the article model** — in `src/models/article.model.ts` change the `id` field and add `contentHash` after `endTime`:

```ts
  id: {
    type: Number,
    required: true,
    unique: true,
  },
```

```ts
  contentHash: {
    type: String,
    required: false,
  },
```

- [ ] **Step 3: Create test DB helper** — `src/test/db.ts`

```ts
import mongoose from "mongoose";

/**
 * Connect to the test database (MONGO_URI_TEST) and make sure all model indexes exist.
 * Import the models under test before calling this.
 */
export async function connectTestDb() {
  const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

export async function clearTestDb() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
```

- [ ] **Step 4: Write the failing test** — `src/services/article-sync.service.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { floorToHour, syncArticles } from "./article-sync.service";

function apiArticle(id: number, type: string, content: string, publishAt = "2026-10-17T12:05:00.000000Z"): ApiArticle {
  return { id, title: `Article ${id}`, type, publish_at: publishAt, message: { content } } as ApiArticle;
}

const hintHtml = "<div>Alpha: <img src='a.png'><br>Bravo: -<br>Charlie: tekst</div>";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("floorToHour", () => {
  test("drops minutes, seconds and milliseconds", () => {
    expect(floorToHour(new Date("2026-10-17T12:59:59.999Z")).toISOString()).toBe("2026-10-17T12:00:00.000Z");
  });
});

describe("syncArticles", () => {
  test("creates one cell per default area for a new hint", async () => {
    const result = await syncArticles([apiArticle(1, "hint", hintHtml)]);
    expect(result.cellsCreated).toBe(9);
    const cells = await HintCell.find({ articleId: 1 }).lean();
    expect(cells).toHaveLength(9);
    const bravo = cells.find((cell) => cell.area === "bravo")!;
    expect(bravo.status).toBe(HintCellStatus.None);
    const alpha = cells.find((cell) => cell.area === "alpha")!;
    expect(alpha.status).toBe(HintCellStatus.Open);
    expect(alpha.snippet).toContain("a.png");
    expect(alpha.slotTime.toISOString()).toBe("2026-10-17T12:00:00.000Z");
  });

  test("uses area names from the Area collection when present", async () => {
    await Area.create([
      { name: "Alpha", status: "red", updatedAt: new Date() },
      { name: "Bravo", status: "red", updatedAt: new Date() },
    ]);
    await syncArticles([apiArticle(2, "hint", hintHtml)]);
    const areas = (await HintCell.find({ articleId: 2 }).lean()).map((cell) => cell.area).sort();
    expect(areas).toEqual(["alpha", "bravo"]);
  });

  test("does not create cells for news", async () => {
    await syncArticles([apiArticle(3, "news", "<div>Nieuws</div>")]);
    expect(await HintCell.countDocuments()).toBe(0);
    expect(await Article.countDocuments()).toBe(1);
  });

  test("is idempotent", async () => {
    await syncArticles([apiArticle(4, "hint", hintHtml)]);
    const second = await syncArticles([apiArticle(4, "hint", hintHtml)]);
    expect(second.cellsCreated).toBe(0);
    expect(second.changedHints).toEqual([]);
    expect(await Article.countDocuments()).toBe(1);
    expect(await HintCell.countDocuments()).toBe(9);
  });

  test("keeps articles that are no longer returned by the API", async () => {
    await syncArticles([apiArticle(5, "hint", hintHtml)]);
    await syncArticles([apiArticle(6, "news", "<div>x</div>")]);
    expect(await Article.exists({ id: 5 })).toBeTruthy();
  });

  test("flags cells when a hint article changes after publication", async () => {
    await syncArticles([apiArticle(7, "hint", hintHtml)]);
    await HintCell.updateOne({ articleId: 7, area: "alpha" }, { $set: { answer: "1234 5678" } });
    const result = await syncArticles([apiArticle(7, "hint", hintHtml + "<p>correctie</p>")]);
    expect(result.changedHints).toEqual([7]);
    const cells = await HintCell.find({ articleId: 7 }).lean();
    expect(cells.every((cell) => cell.articleChanged)).toBe(true);
    expect(cells.find((cell) => cell.area === "alpha")!.answer).toBe("1234 5678");
  });
});
```

- [ ] **Step 5: Run test to verify it fails** — `bun_ test src/services/article-sync.service.test.ts` → FAIL, module `./article-sync.service` not found.

- [ ] **Step 6: Implement** — `src/services/article-sync.service.ts`

```ts
import { createHash } from "node:crypto";
import { Article } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { DEFAULT_AREAS, parseHintArticle } from "./hint-parser";

export interface SyncResult {
  upserted: number;
  changedHints: number[];
  cellsCreated: number;
}

export function floorToHour(date: Date): Date {
  const floored = new Date(date);
  floored.setUTCMinutes(0, 0, 0);
  return floored;
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function getAreaNames(): Promise<string[]> {
  const areas = await Area.find({}, { name: 1 }).lean();
  return areas.length ? areas.map((area) => area.name.toLowerCase()) : DEFAULT_AREAS;
}

/**
 * Create the per-area cells for a hint article, if they don't exist yet.
 * @returns The number of cells created
 */
export async function ensureHintCells(article: { id: number; publishAt: Date; content: string }): Promise<number> {
  if (await HintCell.exists({ articleId: article.id })) return 0;

  const parsed = parseHintArticle(article.content, await getAreaNames());
  const cells = Object.entries(parsed).map(([area, part]) => ({
    articleId: article.id,
    area,
    publishAt: article.publishAt,
    slotTime: floorToHour(article.publishAt),
    snippet: part.snippet ?? undefined,
    status: part.none ? HintCellStatus.None : HintCellStatus.Open,
  }));

  try {
    await HintCell.insertMany(cells, { ordered: false });
  } catch (error) {
    // Duplicate key: another run created the cells at the same time
    if ((error as { code?: number }).code !== 11000) throw error;
    return 0;
  }
  return cells.length;
}

/**
 * Upsert articles from the Jotihunt API (never deletes, so older hints are kept),
 * create hint cells for new hint articles and flag cells of edited hint articles.
 */
export async function syncArticles(apiArticles: ApiArticle[]): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, changedHints: [], cellsCreated: 0 };

  for (const apiArticle of apiArticles) {
    const content = apiArticle.message.content;
    const contentHash = hashContent(content);
    const publishAt = new Date(apiArticle.publish_at);

    const previous = await Article.findOneAndUpdate(
      { id: apiArticle.id },
      {
        $set: {
          title: apiArticle.title,
          type: apiArticle.type,
          publishAt,
          content,
          messageType: apiArticle.message.type,
          maxPoints: apiArticle.message.max_points,
          endTime: apiArticle.message.end_time,
          contentHash,
        },
      },
      { upsert: true },
    ).lean();
    result.upserted++;

    if (apiArticle.type !== "hint") continue;

    if (previous?.contentHash && previous.contentHash !== contentHash) {
      await HintCell.updateMany({ articleId: apiArticle.id }, { $set: { articleChanged: true } });
      result.changedHints.push(apiArticle.id);
    }

    result.cellsCreated += await ensureHintCells({ id: apiArticle.id, publishAt, content });
  }

  return result;
}
```

- [ ] **Step 7: Run tests** — `bun_ test src/services/article-sync.service.test.ts` → PASS.
  If `endTime: undefined` causes a cast error on hint articles, it means undefined keys are not stripped: build the `$set` object without undefined values (`Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))`) and rerun.

- [ ] **Step 8: Rewrite the cron** — replace `src/crons/jotihunt-articles.cron.ts` entirely:

```ts
import { logger } from "..";
import { getArticles } from "../services/jotihunt.service";
import { syncArticles } from "../services/article-sync.service";

export default async function retrieveJotihuntArticles() {
  logger.info("(CRON) Retrieving Jotihunt articles from API...");

  const apiArticles = await getArticles();
  const result = await syncArticles(apiArticles);

  logger.info(`(CRON) Synced ${result.upserted} articles, created ${result.cellsCreated} hint cells`);
  if (result.changedHints.length) {
    logger.warn(`(CRON) Hint articles changed after publication: ${result.changedHints.join(", ")}`);
  }
}
```

- [ ] **Step 9: Verify** — `bun_ test` (all files) PASS, `bun_ run typecheck`, `bun_ run lint` clean.

- [ ] **Step 10: Commit**

```bash
git add src/models src/services/article-sync.service.ts src/services/article-sync.service.test.ts src/test src/crons/jotihunt-articles.cron.ts
git commit -m "feat(hints): add HintCell model and upsert-based article sync

Articles were deleted and re-inserted every 10s from page 1 only, so older
hints disappeared during the hunt. Articles are now upserted by id and
hint articles get one HintCell per area.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Hint board service (server)

**Files:**
- Create: `src/services/hint-board.service.ts`
- Test: `src/services/hint-board.service.test.ts`

**Interfaces:**
- Consumes: `HintCell`, `HintCellStatus`, `HintCheck` (Task 3); `parseRdAnswer` (Task 2); `Marker`, `MarkerType` from `src/models/marker.model.ts`; `Article`; `User` model.
- Produces:
  - `class HintBoardError extends Error { status: number; details: Record<string, unknown> }`
  - `getBoard(): Promise<{ articles: { id; title; publishAt; content }[]; cells: HintCell[] }>`
  - `claimCell(articleId: number, area: string, userId: Id)`
  - `releaseCell(articleId: number, area: string, user: { _id: Id; admin: boolean })`
  - `solveCell(articleId: number, area: string, userId: Id, answer: string, replaceMarker?: boolean)`
  - `setCheck(articleId: number, area: string, userId: Id, check: HintCheck)`
  - `addNote(articleId: number, area: string, userId: Id, text: string)`
  - `setStatus(articleId: number, area: string, status: HintCellStatus.Open | HintCellStatus.None)`
  - All mutations return the updated cell with `claimedBy`, `checkedBy`, `notes.user` populated to `{ _id, name }`.
  - `type Id = mongoose.Types.ObjectId | string`

- [ ] **Step 1: Write the failing test** — `src/services/hint-board.service.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { addNote, claimCell, getBoard, HintBoardError, releaseCell, setCheck, setStatus, solveCell } from "./hint-board.service";

const slotTime = new Date("2026-10-17T12:00:00.000Z");

async function makeUser(name: string, admin = false) {
  return User.create({ email: `${name}@test.nl`, password: "x", name, admin });
}

async function makeCell(area = "alpha", status = HintCellStatus.Open) {
  return HintCell.create({ articleId: 1, area, publishAt: new Date("2026-10-17T12:02:00.000Z"), slotTime, status });
}

async function expectBoardError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HintBoardError);
    expect((error as HintBoardError).status).toBe(status);
    return error as HintBoardError;
  }
  throw new Error(`Expected HintBoardError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("getBoard", () => {
  test("returns hint articles newest first and populated cells", async () => {
    const user = await makeUser("merida");
    await Article.create([
      { id: 1, title: "Hint 1", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" },
      { id: 2, title: "Hint 2", type: "hint", publishAt: new Date("2026-10-17T13:00:00Z"), content: "b" },
      { id: 3, title: "Nieuws", type: "news", publishAt: new Date("2026-10-17T14:00:00Z"), content: "c" },
    ]);
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const board = await getBoard();
    expect(board.articles.map((article) => article.id)).toEqual([2, 1]);
    expect((board.cells[0].claimedBy as unknown as { name: string }).name).toBe("merida");
  });
});

describe("claimCell", () => {
  test("claims an open cell", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await claimCell(1, "alpha", user._id);
    expect(cell.status).toBe(HintCellStatus.Solving);
    expect(String(cell.claimedBy!._id)).toBe(String(user._id));
  });

  test("only one of two concurrent claims wins", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    const results = await Promise.allSettled([claimCell(1, "alpha", a._id), claimCell(1, "alpha", b._id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as HintBoardError).status).toBe(409);
  });

  test("the claimer can claim again", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const again = await claimCell(1, "alpha", user._id);
    expect(again.status).toBe(HintCellStatus.Solving);
  });

  test("409 with claimer name when claimed by someone else", async () => {
    const [a, b] = await Promise.all([makeUser("a"), makeUser("b"), makeCell()]);
    await claimCell(1, "alpha", a._id);
    const error = await expectBoardError(claimCell(1, "alpha", b._id), 409);
    expect((error.details.claimedBy as { name: string }).name).toBe("a");
  });

  test("409 for a none cell, 404 for a missing cell", async () => {
    const user = await makeUser("merida");
    await makeCell("bravo", HintCellStatus.None);
    await expectBoardError(claimCell(1, "bravo", user._id), 409);
    await expectBoardError(claimCell(1, "golf", user._id), 404);
  });
});

describe("releaseCell", () => {
  test("claimer and admin can release, others cannot", async () => {
    const [a, b, admin] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("admin", true), makeCell()]);
    await claimCell(1, "alpha", a._id);
    await expectBoardError(releaseCell(1, "alpha", { _id: b._id, admin: false }), 409);
    const released = await releaseCell(1, "alpha", { _id: admin._id, admin: true });
    expect(released.status).toBe(HintCellStatus.Open);
    expect(released.claimedBy).toBeFalsy();
    await claimCell(1, "alpha", a._id);
    expect((await releaseCell(1, "alpha", { _id: a._id, admin: false })).status).toBe(HintCellStatus.Open);
  });
});

describe("solveCell", () => {
  test("RD answer creates a hint marker at the slot time", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await solveCell(1, "alpha", user._id, "2126 4692");
    expect(cell.status).toBe(HintCellStatus.Solved);
    expect(cell.answerKind).toBe("rd");
    const marker = await Marker.findById(cell.markerId).lean();
    expect(marker!.area).toBe("alpha");
    expect(marker!.type).toBe(MarkerType.Hint);
    expect(marker!.time.toISOString()).toBe(slotTime.toISOString());
    expect(marker!.location.coordinates[1]).toBeCloseTo(52.2079, 3);
  });

  test("solving again moves the same marker", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const first = await solveCell(1, "alpha", user._id, "2126 4692");
    const second = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(String(second.markerId)).toBe(String(first.markerId));
    expect(await Marker.countDocuments()).toBe(1);
  });

  test("text answer creates no marker", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await solveCell(1, "alpha", user._id, "doedelzak");
    expect(cell.answerKind).toBe("text");
    expect(cell.markerId).toBeFalsy();
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("409 when another hint marker exists for the slot, replace on request", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const manual = await Marker.create({
      area: "alpha",
      time: slotTime,
      type: MarkerType.Hint,
      location: { type: "Point", coordinates: [6, 52] },
    });
    const error = await expectBoardError(solveCell(1, "alpha", user._id, "2126 4692"), 409);
    expect(error.details.existingMarkerId).toBe(String(manual._id));

    const cell = await solveCell(1, "alpha", user._id, "2126 4692", true);
    expect(await Marker.exists({ _id: manual._id })).toBeNull();
    expect(await Marker.countDocuments()).toBe(1);
    expect(cell.markerId).toBeTruthy();
  });

  test("solving resets the check", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await solveCell(1, "alpha", user._id, "2126 4692");
    await setCheck(1, "alpha", user._id, HintCheck.Verified);
    const cell = await solveCell(1, "alpha", user._id, "2000 4700");
    expect(cell.check).toBe(HintCheck.Unchecked);
  });
});

describe("setCheck, addNote, setStatus", () => {
  test("setCheck records who checked", async () => {
    const user = await makeUser("merida");
    await makeCell();
    const cell = await setCheck(1, "alpha", user._id, HintCheck.Disputed);
    expect(cell.check).toBe(HintCheck.Disputed);
    expect((cell.checkedBy as unknown as { name: string }).name).toBe("merida");
  });

  test("addNote appends a note with the author", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await addNote(1, "alpha", user._id, "Lijkt Ogham");
    const cell = await addNote(1, "alpha", user._id, "Ja, Ogham");
    expect(cell.notes.map((note) => note.text)).toEqual(["Lijkt Ogham", "Ja, Ogham"]);
    expect((cell.notes[0].user as unknown as { name: string }).name).toBe("merida");
  });

  test("setStatus toggles none and clears the claim", async () => {
    const user = await makeUser("merida");
    await makeCell();
    await claimCell(1, "alpha", user._id);
    const cell = await setStatus(1, "alpha", HintCellStatus.None);
    expect(cell.status).toBe(HintCellStatus.None);
    expect(cell.claimedBy).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun_ test src/services/hint-board.service.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement** — `src/services/hint-board.service.ts`

```ts
import mongoose from "mongoose";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { Marker, MarkerType } from "../models/marker.model";
import "../models/user.model"; // registers the User model for populate
import { parseRdAnswer } from "./rd-answer";

type Id = mongoose.Types.ObjectId | string;

export class HintBoardError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const populateUsers = [
  { path: "claimedBy", select: "name" },
  { path: "checkedBy", select: "name" },
  { path: "notes.user", select: "name" },
];

async function findCellOr404(articleId: number, area: string) {
  const cell = await HintCell.findOne({ articleId, area }).populate(populateUsers);
  if (!cell) throw new HintBoardError(404, "Hint cell not found");
  return cell;
}

async function updateCell(articleId: number, area: string, update: mongoose.UpdateQuery<unknown>) {
  const cell = await HintCell.findOneAndUpdate({ articleId, area }, update, { returnDocument: "after" }).populate(populateUsers);
  if (!cell) throw new HintBoardError(404, "Hint cell not found");
  return cell;
}

export async function getBoard() {
  const articles = await Article.find({ type: "hint" }, { _id: 0, id: 1, title: 1, publishAt: 1, content: 1 })
    .sort({ publishAt: -1 })
    .lean();
  const cells = await HintCell.find().populate(populateUsers).lean();
  return { articles, cells };
}

export async function claimCell(articleId: number, area: string, userId: Id) {
  const cell = await HintCell.findOneAndUpdate(
    {
      articleId,
      area,
      $or: [{ status: HintCellStatus.Open }, { status: HintCellStatus.Solving, claimedBy: userId }],
    },
    { $set: { status: HintCellStatus.Solving, claimedBy: userId, claimedAt: new Date() } },
    { returnDocument: "after" },
  ).populate(populateUsers);
  if (cell) return cell;

  const existing = await findCellOr404(articleId, area);
  const message = existing.status === HintCellStatus.Solving ? "Cell is already claimed" : `Cell is ${existing.status}`;
  throw new HintBoardError(409, message, { claimedBy: existing.claimedBy ?? null });
}

export async function releaseCell(articleId: number, area: string, user: { _id: Id; admin: boolean }) {
  const filter: Record<string, unknown> = { articleId, area, status: HintCellStatus.Solving };
  if (!user.admin) filter.claimedBy = user._id;

  const cell = await HintCell.findOneAndUpdate(
    filter,
    { $set: { status: HintCellStatus.Open }, $unset: { claimedBy: 1, claimedAt: 1 } },
    { returnDocument: "after" },
  ).populate(populateUsers);
  if (cell) return cell;

  await findCellOr404(articleId, area);
  throw new HintBoardError(409, "Cell is not claimed by you");
}

export async function solveCell(articleId: number, area: string, userId: Id, answer: string, replaceMarker = false) {
  const cell = await findCellOr404(articleId, area);
  const rd = parseRdAnswer(answer);
  let markerId: mongoose.Types.ObjectId | undefined;

  if (rd) {
    const location = { type: "Point", coordinates: [rd.lng, rd.lat] };
    const existing = await Marker.findOne({ type: MarkerType.Hint, area, time: cell.slotTime });

    if (existing && cell.markerId && String(existing._id) === String(cell.markerId)) {
      existing.set("location", location);
      await existing.save();
      markerId = existing._id;
    } else {
      if (existing && !replaceMarker) {
        throw new HintBoardError(409, "A hint marker already exists for this area and hour", {
          existingMarkerId: String(existing._id),
        });
      }
      if (existing) await existing.deleteOne();
      const marker = await Marker.create({ area, time: cell.slotTime, type: MarkerType.Hint, location });
      markerId = marker._id;
    }
  } else if (cell.markerId) {
    // Answer changed from a coordinate to a word: remove the marker we created earlier
    await Marker.findByIdAndDelete(cell.markerId);
  }

  const unset: Record<string, 1> = { checkedBy: 1 };
  if (!markerId) unset.markerId = 1;

  return updateCell(articleId, area, {
    $set: {
      answer: answer.trim(),
      answerKind: rd ? "rd" : "text",
      status: HintCellStatus.Solved,
      check: HintCheck.Unchecked,
      claimedBy: userId,
      ...(markerId ? { markerId } : {}),
    },
    $unset: unset,
  });
}

export async function setCheck(articleId: number, area: string, userId: Id, check: HintCheck) {
  if (check === HintCheck.Unchecked) {
    return updateCell(articleId, area, { $set: { check }, $unset: { checkedBy: 1 } });
  }
  return updateCell(articleId, area, { $set: { check, checkedBy: userId } });
}

export async function addNote(articleId: number, area: string, userId: Id, text: string) {
  return updateCell(articleId, area, { $push: { notes: { user: userId, text, createdAt: new Date() } } });
}

export async function setStatus(articleId: number, area: string, status: HintCellStatus.Open | HintCellStatus.None) {
  return updateCell(articleId, area, { $set: { status }, $unset: { claimedBy: 1, claimedAt: 1 } });
}
```

- [ ] **Step 4: Run tests** — `bun_ test src/services/hint-board.service.test.ts` → PASS. Fix typing issues surfaced by `bun_ run typecheck` (e.g. if `returnDocument` is rejected by the Mongoose 9 types, use `{ new: true }` everywhere in this file). `bun_ run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/hint-board.service.ts src/services/hint-board.service.test.ts
git commit -m "feat(hints): add hint board service (claim, solve, check, notes)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Hints API routes + seed script (server)

**Files:**
- Create: `src/controllers/hints.controller.ts`, `src/routes/hints.route.ts`, `src/scripts/seed-hint.ts`
- Modify: `src/index.ts`, `package.json`

**Interfaces:**
- Consumes: everything exported by `hint-board.service.ts` (Task 4), `syncArticles` (Task 3), `DEFAULT_AREAS` (Task 1).
- Produces HTTP API (all require `Authorization: Bearer <jwt>`):
  - `GET /hints/board` → `{ articles, cells }`
  - `POST /hints/:articleId/:area/claim` | `/release` → cell
  - `POST /hints/:articleId/:area/solve` `{ answer: string, replaceMarker?: boolean }` → cell
  - `POST /hints/:articleId/:area/check` `{ check: "unchecked"|"verified"|"disputed" }` → cell
  - `POST /hints/:articleId/:area/notes` `{ text: string }` → cell
  - `POST /hints/:articleId/:area/status` `{ status: "open"|"none" }` → cell
  - Errors: `{ message, ...details }` with status 400/404/409.

- [ ] **Step 1: Controller** — `src/controllers/hints.controller.ts`

```ts
import { Request, Response } from "express";
import * as board from "../services/hint-board.service";
import { HintBoardError } from "../services/hint-board.service";

function cellKey(req: Request) {
  return { articleId: Number(req.params.articleId), area: String(req.params.area).toLowerCase() };
}

async function respond(res: Response, action: () => Promise<unknown>) {
  try {
    return res.status(200).json(await action());
  } catch (error) {
    if (error instanceof HintBoardError) {
      return res.status(error.status).json({ message: error.message, ...error.details });
    }
    throw error;
  }
}

export function getBoard(_req: Request, res: Response) {
  return respond(res, () => board.getBoard());
}

export function claim(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.claimCell(articleId, area, req.user!._id));
}

export function release(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.releaseCell(articleId, area, { _id: req.user!._id, admin: req.user!.admin }));
}

export function solve(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  const { answer, replaceMarker } = req.body;
  return respond(res, () => board.solveCell(articleId, area, req.user!._id, answer, replaceMarker === true));
}

export function check(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.setCheck(articleId, area, req.user!._id, req.body.check));
}

export function addNote(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.addNote(articleId, area, req.user!._id, req.body.text));
}

export function setStatus(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.setStatus(articleId, area, req.body.status));
}
```

- [ ] **Step 2: Routes** — `src/routes/hints.route.ts`

```ts
import express from "express";
import { body, param } from "express-validator";
import * as hintsController from "../controllers/hints.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { DEFAULT_AREAS } from "../services/hint-parser";

const cellParams = [param("articleId").isInt({ min: 0 }), param("area").isIn(DEFAULT_AREAS)];

const router = express.Router();

router.get("/board", verifyToken, hintsController.getBoard);
router.post("/:articleId/:area/claim", [verifyToken, validate(cellParams)], hintsController.claim);
router.post("/:articleId/:area/release", [verifyToken, validate(cellParams)], hintsController.release);
router.post(
  "/:articleId/:area/solve",
  [
    verifyToken,
    validate([
      ...cellParams,
      body("answer").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Antwoord is verplicht."),
      body("replaceMarker").optional().isBoolean(),
    ]),
  ],
  hintsController.solve,
);
router.post(
  "/:articleId/:area/check",
  [verifyToken, validate([...cellParams, body("check").isIn(Object.values(HintCheck))])],
  hintsController.check,
);
router.post(
  "/:articleId/:area/notes",
  [verifyToken, validate([...cellParams, body("text").isString().trim().isLength({ min: 1, max: 1000 })])],
  hintsController.addNote,
);
router.post(
  "/:articleId/:area/status",
  [verifyToken, validate([...cellParams, body("status").isIn([HintCellStatus.Open, HintCellStatus.None])])],
  hintsController.setStatus,
);

export default router;
```

- [ ] **Step 3: Register route** — in `src/index.ts` add `import hintsRoute from "./routes/hints.route";` next to the other route imports, and `app.use("/hints", hintsRoute);` after `app.use("/admin", adminRoute);`.

- [ ] **Step 4: Seed script** — `src/scripts/seed-hint.ts`

```ts
import mongoose from "mongoose";
import { syncArticles } from "../services/article-sync.service";
import { ApiArticle } from "../types/api";

// Seeds a fake hint article (id >= 900000) so the hint board can be tried before the hunt.
// Remove with: db.articles.deleteMany({ id: { $gte: 900000 } }); db.hintcells.deleteMany({ articleId: { $gte: 900000 } })
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set");
  process.exit(1);
}
await mongoose.connect(uri);

const id = 900000 + Math.floor(Math.random() * 100000);
const content =
  `<div><strong>Testhint</strong><br>Merida volgt de irrlichten...<br>` +
  `Alpha: <img src="https://placehold.co/600x200?text=Alpha"><br>` +
  `Bravo: -<br>` +
  `Charlie: tweeduizend honderdzesentwintig vierduizend zeshonderdtweeënnegentig<br>` +
  `Delta: <img src="https://placehold.co/600x200?text=Delta"><br>` +
  `Echo: --<br>` +
  `Foxtrot: 1234 5678 in spiegelschrift<br>` +
  `Golf: <img src="https://placehold.co/600x200?text=Golf"><br>` +
  `Hotel: -<br>` +
  `Oscar: Neem lijn 7 tot de laatste halte</div>`;

const article = {
  id,
  title: `Testhint ${id}`,
  type: "hint",
  publish_at: new Date().toISOString(),
  message: { content },
} as ApiArticle;

const result = await syncArticles([article]);
console.log(`Seeded hint article ${id} with ${result.cellsCreated} cells`);
await mongoose.disconnect();
```

In `package.json` `scripts` add `"seed-hint": "bun run src/scripts/seed-hint.ts",`.

- [ ] **Step 5: Static checks** — `bun_ test`, `bun_ run typecheck`, `bun_ run lint` → all clean.

- [ ] **Step 6: Smoke test against the running stack**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose up -d --build server
sleep 5
docker compose exec -T server bun run seed-hint
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@local.test","password":"JiyhyUihhkDrbqij"}' | jq -r .accessToken)
ART=$(curl -s localhost:3000/hints/board -H "Authorization: Bearer $TOKEN" | jq '.articles[0].id')
curl -s -X POST localhost:3000/hints/$ART/alpha/claim -H "Authorization: Bearer $TOKEN" | jq '{status, claimedBy}'
curl -s -X POST localhost:3000/hints/$ART/alpha/solve -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"answer":"2126 4692"}' | jq '{status, answerKind, markerId}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/hints/$ART/bravo/claim -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/hints/$ART/zulu/claim -H "Authorization: Bearer $TOKEN"
```

Expected: seed prints `... with 9 cells`; claim → `status: "solving"`, `claimedBy.name: "Admin"`; solve → `status: "solved"`, `answerKind: "rd"`, a `markerId`; bravo claim → `409` (it is `none`); zulu → `400`.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/hints.controller.ts src/routes/hints.route.ts src/index.ts src/scripts/seed-hint.ts package.json
git commit -m "feat(hints): expose hint board API and add seed script

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Client data layer (types, RD parser, helpers, hook)

Work in `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`.

**Files:**
- Create: `src/types/HintCell.ts`, `src/lib/rd-answer.ts`, `src/lib/hints.ts`, `src/hooks/hints.hook.ts`
- Test: `src/lib/rd-answer.test.ts`, `src/lib/hints.test.ts`
- Modify: `package.json` (add `dompurify`, `"test": "bun test"`), `tsconfig.app.json` (exclude tests)

**Interfaces:**
- Consumes: server API from Task 5; `useAuthSWR`, `fetcherWithMethod` from `src/lib/swr.ts`.
- Produces:
  - Types `HintCellStatus`, `HintCheck`, `UserRef`, `HintNote`, `HintCell`, `HintArticle`, `HintBoard`.
  - `parseRdAnswer(text: string): { x: number; y: number; lng: number; lat: number } | null` (same rules as server).
  - `HINT_WINDOW_MS`, `remainingMs(publishAt: string, now: number): number`, `formatCountdown(ms: number): string`, `sanitizeHintHtml(html: string): string`.
  - `useHintBoard()` → `{ board?: HintBoard; isLoading: boolean; isError: unknown; claim(articleId, area); release(articleId, area); solve(articleId, area, answer, replaceMarker?); setCheck(articleId, area, check); addNote(articleId, area, text); setStatus(articleId, area, status) }`, each mutation `Promise<HintCell>` that throws the axios error on failure.

- [ ] **Step 1: Dependencies/config** — `bun_ add dompurify`. In `package.json` scripts add `"test": "bun test"`. In `tsconfig.app.json` add after `"include": ["src"]`: `"exclude": ["src/**/*.test.ts"]` (so `tsc -b` doesn't need `bun:test` types).

- [ ] **Step 2: Types** — `src/types/HintCell.ts`

```ts
export type HintCellStatus = 'open' | 'solving' | 'solved' | 'none';
export type HintCheck = 'unchecked' | 'verified' | 'disputed';

export interface UserRef {
  _id: string;
  name: string;
}

export interface HintNote {
  _id: string;
  user: UserRef | null;
  text: string;
  createdAt: string;
}

export interface HintCell {
  _id: string;
  articleId: number;
  area: string;
  publishAt: string;
  slotTime: string;
  snippet?: string;
  status: HintCellStatus;
  claimedBy?: UserRef | null;
  claimedAt?: string;
  answer?: string;
  answerKind?: 'rd' | 'text';
  markerId?: string;
  check: HintCheck;
  checkedBy?: UserRef | null;
  notes: HintNote[];
  articleChanged: boolean;
}

export interface HintArticle {
  id: number;
  title: string;
  publishAt: string;
  content: string;
}

export interface HintBoard {
  articles: HintArticle[];
  cells: HintCell[];
}
```

- [ ] **Step 3: Write failing tests** — `src/lib/rd-answer.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { parseRdAnswer } from './rd-answer';

describe('parseRdAnswer', () => {
  test('converts 4+4 digits', () => {
    const result = parseRdAnswer('2126 4692');
    expect(result?.x).toBe(212600);
    expect(result?.y).toBe(469200);
    expect(result!.lat).toBeCloseTo(52.2079, 3);
    expect(result!.lng).toBeCloseTo(6.2299, 3);
  });

  test.each([['21264692'], ['212600 469200'], ['2126,4692']])('accepts %p', (input) => {
    expect(parseRdAnswer(input)?.x).toBe(212600);
  });

  test.each([['doedelzak'], ['2126 469200'], ['0000 0000'], ['']])('rejects %p', (input) => {
    expect(parseRdAnswer(input)).toBeNull();
  });
});
```

`src/lib/hints.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatCountdown, HINT_WINDOW_MS, remainingMs } from './hints';

describe('hint timer', () => {
  const publishAt = '2026-10-17T12:00:00.000Z';
  const start = new Date(publishAt).getTime();

  test('remainingMs counts down from 20 minutes', () => {
    expect(remainingMs(publishAt, start)).toBe(HINT_WINDOW_MS);
    expect(remainingMs(publishAt, start + 60_000)).toBe(HINT_WINDOW_MS - 60_000);
  });

  test('formatCountdown', () => {
    expect(formatCountdown(20 * 60_000)).toBe('20:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
```

Run `bun_ test` → FAIL (modules missing).

- [ ] **Step 4: Implement** — `src/lib/rd-answer.ts`

```ts
import proj4 from 'proj4';

// Same definition as main.tsx; repeated so this module also works outside the app (tests)
proj4.defs(
  'RD',
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
);

/**
 * Parse a hint answer as an RD coordinate (mirrors the server's parser).
 * @param text The answer as entered
 * @returns RD and WGS84 coordinates, or null when not a valid RD coordinate
 */
export function parseRdAnswer(text: string): { x: number; y: number; lng: number; lat: number } | null {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  let xs: string;
  let ys: string;

  if (parts.length === 1 && /^(\d{8}|\d{12})$/.test(parts[0])) {
    const half = parts[0].length / 2;
    xs = parts[0].slice(0, half);
    ys = parts[0].slice(half);
  } else if (parts.length === 2 && parts[0].length === parts[1].length && parts.every((part) => /^(\d{4}|\d{6})$/.test(part))) {
    [xs, ys] = parts;
  } else {
    return null;
  }

  const x = xs.length === 4 ? Number(xs) * 100 : Number(xs);
  const y = ys.length === 4 ? Number(ys) * 100 : Number(ys);
  if (x < 0 || x > 290000 || y < 290000 || y > 630000) return null;

  const [lng, lat] = proj4('RD', 'WGS84', [x, y]);
  return { x, y, lng, lat };
}
```

`src/lib/hints.ts`:

```ts
import DOMPurify from 'dompurify';

export const HINT_WINDOW_MS = 20 * 60 * 1000;

/**
 * Milliseconds left in the 20-minute scoring window of a hint.
 */
export function remainingMs(publishAt: string, now: number) {
  return new Date(publishAt).getTime() + HINT_WINDOW_MS - now;
}

/**
 * Format milliseconds as m:ss (rounded up, never negative).
 */
export function formatCountdown(ms: number) {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/**
 * Sanitise Jotihunt article HTML before rendering it.
 */
export function sanitizeHintHtml(html: string) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['div', 'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'span', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'img', 'a', 'figure', 'figcaption'],
    ALLOWED_ATTR: ['src', 'href', 'alt', 'width', 'height'],
  });
}
```

`src/hooks/hints.hook.ts`:

```ts
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod, useAuthSWR } from '@/lib/swr';
import { HintBoard, HintCell, HintCheck } from '@/types/HintCell';

export const useHintBoard = () => {
  const authHeader = useAuthHeader() || '';
  const { data, error, mutate } = useAuthSWR<HintBoard>('/hints/board', { refreshInterval: 3000 });

  /**
   * Post an action for a cell and put the returned cell straight into the cache.
   * Throws the axios error on failure so callers can show the right message.
   */
  async function post(articleId: number, area: string, action: string, body?: unknown): Promise<HintCell> {
    const cell = (await fetcherWithMethod(`/hints/${articleId}/${area}/${action}`, authHeader, 'POST', body)) as HintCell;
    await mutate(
      (current) => current && { ...current, cells: current.cells.map((existing) => (existing._id === cell._id ? cell : existing)) },
      { revalidate: false },
    );
    return cell;
  }

  return {
    board: data,
    isLoading: !error && !data,
    isError: error,
    claim: (articleId: number, area: string) => post(articleId, area, 'claim'),
    release: (articleId: number, area: string) => post(articleId, area, 'release'),
    solve: (articleId: number, area: string, answer: string, replaceMarker = false) =>
      post(articleId, area, 'solve', { answer, replaceMarker }),
    setCheck: (articleId: number, area: string, check: HintCheck) => post(articleId, area, 'check', { check }),
    addNote: (articleId: number, area: string, text: string) => post(articleId, area, 'notes', { text }),
    setStatus: (articleId: number, area: string, status: 'open' | 'none') => post(articleId, area, 'status', { status }),
  };
};
```

- [ ] **Step 5: Verify** — `bun_ test` PASS; `bun_ run build` and `bun_ run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock tsconfig.app.json src/types/HintCell.ts src/lib/rd-answer.ts src/lib/rd-answer.test.ts src/lib/hints.ts src/lib/hints.test.ts src/hooks/hints.hook.ts
git commit -m "feat(hints): add hint board data layer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Hint board UI (client)

**Files:**
- Create: `src/components/hints/HintGrid.tsx`, `src/components/hints/HintCellPanel.tsx`, `src/pages/Hints.tsx`
- Modify: `src/Routes.tsx`, `src/components/Settings.tsx`

**Interfaces:**
- Consumes: Task 6 exports; `areaOptions`, `cn`, `getColorFromArea` from `src/lib/utils.ts`; `useOutlet` (`{ mapRef }`) from `src/hooks/outlet.hook.ts`; `useInterval(callback, delayMs)` from `src/hooks/utils/interval.hook.ts`; shadcn `Button`, `Input`, `Textarea`, `Badge`, `AlertDialog*`; `hint-alert.mp3` + `use-sound`.
- Produces: route `/hints`; `HintGrid` props `{ articles: HintArticle[]; cells: HintCell[]; now: number; selected?: CellKey; onSelect(key: CellKey): void }`; `HintCellPanel` props `{ article: HintArticle; cell: HintCell; currentUserId?: string; actions: ReturnType<typeof useHintBoard>; onClose(): void; onShowOnMap(lng: number, lat: number): void }`; `type CellKey = { articleId: number; area: string }` exported from `HintGrid.tsx`.

- [ ] **Step 1: Grid** — `src/components/hints/HintGrid.tsx`

```tsx
import { CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { HintArticle, HintCell } from '@/types/HintCell';
import { areaOptions, cn, getColorFromArea } from '@/lib/utils';
import { formatCountdown, remainingMs } from '@/lib/hints';

export type CellKey = { articleId: number; area: string };

interface HintGridProps {
  articles: HintArticle[];
  cells: HintCell[];
  now: number;
  selected?: CellKey;
  onSelect: (key: CellKey) => void;
}

const statusClass: Record<HintCell['status'], string> = {
  open: 'bg-muted hover:bg-muted/70',
  solving: 'bg-amber-200 hover:bg-amber-300 dark:bg-amber-900 dark:hover:bg-amber-800',
  solved: 'bg-green-200 hover:bg-green-300 dark:bg-green-900 dark:hover:bg-green-800',
  none: 'bg-background border border-dashed text-muted-foreground',
};

export default function HintGrid({ articles, cells, now, selected, onSelect }: HintGridProps) {
  const cellsByKey = new Map(cells.map((cell) => [`${cell.articleId}:${cell.area}`, cell]));

  return (
    <table className="w-full border-separate border-spacing-1 text-sm">
      <thead>
        <tr>
          <th className="p-2 text-left">Hint</th>
          {areaOptions.map((area) => (
            <th key={area.value} className="p-2 font-medium">
              <span className="mr-1 inline-block size-2 rounded-full" style={{ backgroundColor: getColorFromArea(area.value) }} />
              {area.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {articles.map((article) => (
          <tr key={article.id}>
            <td className="p-2 whitespace-nowrap align-top">
              <div className="font-medium">
                {new Date(article.publishAt).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="max-w-40 truncate text-xs text-muted-foreground">{article.title}</div>
            </td>
            {areaOptions.map((area) => {
              const cell = cellsByKey.get(`${article.id}:${area.value}`);
              if (!cell) return <td key={area.value} />;
              const left = remainingMs(cell.publishAt, now);
              const showTimer = (cell.status === 'open' || cell.status === 'solving') && left > 0;
              const isSelected = selected?.articleId === article.id && selected.area === area.value;
              return (
                <td key={area.value} className="p-0">
                  <button
                    type="button"
                    onClick={() => onSelect({ articleId: article.id, area: area.value })}
                    className={cn(
                      'flex h-16 w-full flex-col justify-between rounded-md p-2 text-left transition-colors',
                      statusClass[cell.status],
                      isSelected && 'ring-2 ring-primary',
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs">{cell.status === 'none' ? 'geen hint' : (cell.claimedBy?.name ?? '')}</span>
                      {cell.check === 'verified' && <CheckIcon className="size-4 text-green-700 dark:text-green-400" />}
                      {cell.check === 'disputed' && <TriangleAlertIcon className="size-4 text-red-600" />}
                    </div>
                    <div className="flex items-end justify-between gap-1 text-xs">
                      <span className="truncate font-mono">{cell.status === 'solved' ? cell.answer : ''}</span>
                      {showTimer && (
                        <span className={cn('font-mono', left < 5 * 60 * 1000 && 'font-bold text-red-600')}>{formatCountdown(left)}</span>
                      )}
                    </div>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Panel** — `src/components/hints/HintCellPanel.tsx`

```tsx
import { useState } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { MapPinIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { HintArticle, HintCell } from '@/types/HintCell';
import { useHintBoard } from '@/hooks/hints.hook';
import { parseRdAnswer } from '@/lib/rd-answer';
import { sanitizeHintHtml } from '@/lib/hints';
import { capitalizeFirstLetter } from '@/lib/utils';

interface HintCellPanelProps {
  article: HintArticle;
  cell: HintCell;
  currentUserId?: string;
  actions: ReturnType<typeof useHintBoard>;
  onClose: () => void;
  onShowOnMap: (lng: number, lat: number) => void;
}

function errorMessage(error: unknown) {
  if (isAxiosError(error)) return error.response?.data?.message ?? error.message;
  return String(error);
}

/**
 * Open clicked images in a new tab so they can be zoomed.
 */
function openImage(event: React.MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLImageElement) {
    event.preventDefault();
    window.open(target.src, '_blank', 'noopener');
  }
}

export default function HintCellPanel({ article, cell, currentUserId, actions, onClose, onShowOnMap }: HintCellPanelProps) {
  const [answer, setAnswer] = useState(cell.answer ?? '');
  const [note, setNote] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  const { articleId, area } = cell;
  const rd = parseRdAnswer(answer);
  const solvedRd = cell.answer ? parseRdAnswer(cell.answer) : null;
  const claimedByMe = cell.status === 'solving' && cell.claimedBy?._id === currentUserId;

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409 && error.response.data?.claimedBy) {
        toast.error(`Al geclaimd door ${error.response.data.claimedBy.name}`);
      } else {
        toast.error('Actie mislukt', { description: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer(replaceMarker = false) {
    setBusy(true);
    try {
      await actions.solve(articleId, area, answer, replaceMarker);
      toast.success(rd ? 'Opgelost, hint-marker geplaatst!' : 'Antwoord opgeslagen');
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409 && error.response.data?.existingMarkerId) {
        setConfirmReplace(true);
      } else {
        toast.error('Opslaan mislukt', { description: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col gap-4 overflow-y-auto border-l bg-background p-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">{capitalizeFirstLetter(area)}</h2>
          <p className="text-sm text-muted-foreground">
            {article.title} · {new Date(article.publishAt).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Sluiten">
          <XIcon />
        </Button>
      </div>

      {cell.articleChanged && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500 p-2 text-sm">
          <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />
          De hint is na publicatie aangepast. Controleer het antwoord.
        </div>
      )}

      <div
        className="rounded-md border p-3 text-sm [&_img]:max-w-full [&_img]:cursor-zoom-in"
        onClick={openImage}
        dangerouslySetInnerHTML={{ __html: sanitizeHintHtml(cell.snippet ?? article.content) }}
      />
      {cell.snippet && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Volledige hint</summary>
          <div
            className="mt-2 rounded-md border p-3 [&_img]:max-w-full [&_img]:cursor-zoom-in"
            onClick={openImage}
            dangerouslySetInnerHTML={{ __html: sanitizeHintHtml(article.content) }}
          />
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {cell.status === 'open' && (
          <Button disabled={busy} onClick={() => run(() => actions.claim(articleId, area))}>
            Claimen
          </Button>
        )}
        {cell.status === 'solving' && !claimedByMe && <span className="text-sm">Bezig: {cell.claimedBy?.name}</span>}
        {claimedByMe && (
          <Button variant="outline" disabled={busy} onClick={() => run(() => actions.release(articleId, area))}>
            Vrijgeven
          </Button>
        )}
        {cell.status === 'none' ? (
          <Button variant="outline" disabled={busy} onClick={() => run(() => actions.setStatus(articleId, area, 'open'))}>
            Toch een hint
          </Button>
        ) : (
          cell.status !== 'solved' && (
            <Button variant="ghost" disabled={busy} onClick={() => run(() => actions.setStatus(articleId, area, 'none'))}>
              Geen hint
            </Button>
          )
        )}
      </div>

      {cell.status !== 'none' && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) submitAnswer();
          }}
        >
          <label className="text-sm font-medium" htmlFor="hint-answer">
            Antwoord
          </label>
          <div className="flex gap-2">
            <Input id="hint-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="1234 5678 of woord" />
            <Button type="submit" disabled={busy || !answer.trim()}>
              Oplossen
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {rd
              ? `RD ${rd.x}, ${rd.y} → ${rd.lat.toFixed(5)}, ${rd.lng.toFixed(5)}`
              : answer.trim()
                ? 'Geen coördinaat: wordt als tekst-antwoord opgeslagen.'
                : ''}
          </p>
        </form>
      )}

      {cell.status === 'solved' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={cell.check === 'verified' ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => run(() => actions.setCheck(articleId, area, cell.check === 'verified' ? 'unchecked' : 'verified'))}
          >
            Klopt
          </Button>
          <Button
            variant={cell.check === 'disputed' ? 'destructive' : 'outline'}
            disabled={busy}
            onClick={() => run(() => actions.setCheck(articleId, area, cell.check === 'disputed' ? 'unchecked' : 'disputed'))}
          >
            Twijfel
          </Button>
          {cell.checkedBy && <span className="text-xs text-muted-foreground">door {cell.checkedBy.name}</span>}
          {solvedRd && (
            <Button variant="secondary" onClick={() => onShowOnMap(solvedRd.lng, solvedRd.lat)}>
              <MapPinIcon />
              Toon op kaart
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Notities</h3>
        {cell.notes.length === 0 && <p className="text-xs text-muted-foreground">Nog geen notities.</p>}
        <ul className="flex flex-col gap-2">
          {cell.notes.map((item) => (
            <li key={item._id} className="rounded-md bg-muted p-2 text-sm">
              <div className="text-xs text-muted-foreground">
                {item.user?.name ?? 'Onbekend'} · {new Date(item.createdAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="whitespace-pre-wrap">{item.text}</div>
            </li>
          ))}
        </ul>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Bijv. lijkt Ogham, zie regel 2" />
        <Button
          variant="outline"
          disabled={busy || !note.trim()}
          onClick={() => run(async () => {
            await actions.addNote(articleId, area, note.trim());
            setNote('');
          })}
        >
          Notitie toevoegen
        </Button>
      </div>

      <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hint-marker vervangen?</AlertDialogTitle>
            <AlertDialogDescription>
              Er staat al een hint-marker voor {capitalizeFirstLetter(area)} op dit uur. Wil je die vervangen door dit antwoord?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={() => submitAnswer(true)}>Vervangen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
```

- [ ] **Step 3: Page** — `src/pages/Hints.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import useSound from 'use-sound';
import useAuthUser from 'react-auth-kit/hooks/useAuthUser';
import { ArrowLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import HintGrid, { CellKey } from '@/components/hints/HintGrid';
import HintCellPanel from '@/components/hints/HintCellPanel';
import { useHintBoard } from '@/hooks/hints.hook';
import { useOutlet } from '@/hooks/outlet.hook';
import useInterval from '@/hooks/utils/interval.hook';
import hintAlert from '@/assets/audio/hint-alert.mp3';
import { User } from '@/types/User';

export default function Hints() {
  const navigate = useNavigate();
  const { mapRef } = useOutlet();
  const user = useAuthUser<User>();
  const actions = useHintBoard();
  const { board, isLoading } = actions;
  const [selected, setSelected] = useState<CellKey>();
  const [now, setNow] = useState(() => Date.now());
  const [play] = useSound(hintAlert);
  const knownArticleIds = useRef<Set<number> | null>(null);

  useInterval(() => setNow(Date.now()), 1000);

  // Alert when a new hint article appears (not on first load)
  useEffect(() => {
    if (!board) return;
    if (knownArticleIds.current === null) {
      knownArticleIds.current = new Set(board.articles.map((article) => article.id));
      return;
    }
    const fresh = board.articles.filter((article) => !knownArticleIds.current!.has(article.id));
    if (fresh.length === 0) return;
    fresh.forEach((article) => knownArticleIds.current!.add(article.id));
    play();
    toast.info('Nieuwe hint!', { description: fresh[0].title });
  }, [board, play]);

  const selectedArticle = board?.articles.find((article) => article.id === selected?.articleId);
  const selectedCell = board?.cells.find((cell) => cell.articleId === selected?.articleId && cell.area === selected?.area);

  function showOnMap(lng: number, lat: number) {
    navigate('/');
    mapRef.current?.flyTo({ center: [lng, lat], duration: 2000, zoom: 15 });
  }

  return (
    <div className="absolute inset-0 z-40 flex bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b p-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')} aria-label="Terug naar kaart">
            <ArrowLeftIcon />
          </Button>
          <h1 className="text-2xl font-bold">Hints</h1>
          <div className="ml-auto flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="size-3 rounded bg-muted" />open</span>
            <span className="flex items-center gap-1"><span className="size-3 rounded bg-amber-200 dark:bg-amber-900" />bezig</span>
            <span className="flex items-center gap-1"><span className="size-3 rounded bg-green-200 dark:bg-green-900" />opgelost</span>
            <span className="flex items-center gap-1"><span className="size-3 rounded border border-dashed" />geen hint</span>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-2">
          {isLoading && <p className="p-4 text-muted-foreground">Laden...</p>}
          {board && board.articles.length === 0 && <p className="p-4 text-muted-foreground">Nog geen hints gepubliceerd.</p>}
          {board && board.articles.length > 0 && (
            <HintGrid articles={board.articles} cells={board.cells} now={now} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </div>
      {selectedArticle && selectedCell && (
        <HintCellPanel
          key={selectedCell._id}
          article={selectedArticle}
          cell={selectedCell}
          currentUserId={user?._id}
          actions={actions}
          onClose={() => setSelected(undefined)}
          onShowOnMap={showOnMap}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Route** — in `src/Routes.tsx` add `import Hints from './pages/Hints';` and inside the `/` layout route, after the `/users` route: `<Route path="/hints" element={<Hints />} />`.

- [ ] **Step 5: Menu item** — in `src/components/Settings.tsx`: add `PuzzleIcon` to the existing `lucide-react` import list (the one containing `UsersIcon`), and insert right after the `<DropdownMenuSeparator/>` that precedes `{auth?.admin && (` (visible for every user):

```tsx
<DropdownMenuItem onClick={() => navigate('/hints')}>
    <PuzzleIcon/>
    Hint board
</DropdownMenuItem>
```

- [ ] **Step 6: Static checks** — `bun_ test`, `bun_ run build`, `bun_ run lint` → clean. Fix any react-hooks lint findings properly (no blanket disables).

- [ ] **Step 7: Commit**

```bash
git add src/components/hints src/pages/Hints.tsx src/Routes.tsx src/components/Settings.tsx
git commit -m "feat(hints): add hint board page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification on the local stack

**Files:** none (verification only; fix bugs found in the relevant task's files and commit as `fix(hints): ...`).

- [ ] **Step 1: Rebuild and seed**

```bash
cd "/home/silke/Documents/Jotihunt 2026"
docker compose up -d --build server client
sleep 8
docker compose exec -T server bun run seed-hint
docker compose exec -T server bun run create-user --email solver@local.test --password Solver123456 --name Solver --admin false
```

- [ ] **Step 2: Browser session A** (admin@local.test / JiyhyUihhkDrbqij) at http://localhost:8080 → menu → "Hint board". Check:
  - the seeded row shows 9 cells; bravo/echo/hotel show "geen hint"; timers count down from ~20:00;
  - clicking Alpha shows the Alpha placeholder image; Oscar shows the "lijn 7" text; "Volledige hint" expands the whole article;
  - Claim Alpha → cell turns amber with "Admin".

- [ ] **Step 3: Browser session B** (private window, solver@local.test; set a new password when prompted): within ~3 s Alpha shows amber "Admin"; clicking Claim on Alpha shows toast "Al geclaimd door Admin". Add a note on Alpha → visible in session A within ~3 s.

- [ ] **Step 4: Solve** in A: answer `2126 4692` → preview shows `52.207…, 6.229…`; submit → green cell; "Toon op kaart" flies to Zutphen area with the hint marker visible. In B mark "Twijfel" → A shows the warning icon.

- [ ] **Step 5: Marker conflict**: on the main map use the existing hint form to register a hint for Delta at the seeded hour, then solve Delta on the board → "Hint-marker vervangen?" dialog → Vervangen → only one Delta hint marker for that hour remains.

- [ ] **Step 6: New-hint alert**: keep the board open, run `docker compose exec -T server bun run seed-hint` again → sound + "Nieuwe hint!" toast, new row on top.

- [ ] **Step 7: Clean up seeded data**

```bash
docker compose exec -T mongodb mongosh jotihunt --quiet --eval \
  'db.articles.deleteMany({id:{$gte:900000}}); db.hintcells.deleteMany({articleId:{$gte:900000}})'
```
