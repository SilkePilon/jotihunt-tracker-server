# AI hint split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the regex creates a hint's area cells, a background Gemini job re-splits the article per deelgebied and corrects open/none status and snippets (never touching solved cells); the intel window lets "geen hint" rows be answered anyway.

**Architecture:** New `src/services/hint-split.service.ts` (blocks, prompt, splitter, apply, job) mirroring `src/services/article-summary.service.ts`; new cron `src/crons/hint-split.cron.ts` mirroring `article-summaries.cron.ts`; `Article.hintSplitHash`. Client change confined to `src/components/intel-window/HintPane.tsx`.

**Tech Stack:** Bun tests, TypeScript, Express/Mongoose, Vercel AI SDK (`generateText` + `Output.object` + `jsonSchema`), node-cron; client React + motion.

Spec: `docs/superpowers/specs/2026-10-14-ai-hint-split-design.md`.

## Global Constraints

- Server: `npx --yes bun test <file>`, `npx --yes bun x tsc --noEmit`, `npx --yes bun run lint`. Client: `npm run build`, `npm run lint`, `npx --yes bun test`.
- Branch `feat/ai-hint-split` from `main` (server in `jotihunt-tracker-server`; client in a worktree `.worktrees/client-ai-hint-split` — another session works on the client's main checkout).
- Never touch a `solved` cell. Snippets are built only from the article's own HTML blocks.
- AI model purpose `summary`; structured output; `maxRetries: 0`; timeout 30 s; errors wrapped with `toGeminiError`; same pause/backoff/give-up behaviour as the summary job.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Blocks, prompt, splitter and apply (server)

**Files:** Create `src/services/hint-split.service.ts`, `src/services/hint-split.service.test.ts`; modify `src/models/article.model.ts` (add `hintSplitHash: { type: String, required: false }` with doc comment "contentHash the AI hint split was made from").

**Interfaces (Produces):**
```ts
export interface HintBlock { index: number; html: string; text: string } // text: plain text, images as "[afbeelding: <alt or file name>]"
export function hintBlocks(html: string): HintBlock[];                     // numbered from 0, empty blocks dropped
export function buildHintSplitPrompt(article: { title: string; content: string }, areas: string[]): string;
export interface AreaSplit { area: string; none: boolean; blocks: number[] } // area lowercase
export type HintSplit = AreaSplit[];                                        // only areas the AI answered usably
export interface HintSplitter { split(article: { title: string; content: string }, areas: string[]): Promise<HintSplit> } // throws GeminiError
export function createHintSplitter(opts: { model: LanguageModel; timeoutMs?: number }): HintSplitter;
export function snippetFor(blocks: HintBlock[], split: AreaSplit): string | undefined; // original html of its blocks joined in order; undefined when none/no blocks
export async function applyHintSplit(article: { id: number; content: string; contentHash: string }, split: HintSplit): Promise<{ changed: string[] }>;
```

- [ ] **Step 1: Tests first** (`hint-split.service.test.ts`, use the test DB helpers like `hint-board.service.test.ts`; mock model like `article-summary.service.test.ts`):
  - `hintBlocks`: `"intro<br>Alpha: <img src='/x/a.png' alt='A'><br>Bravo: -"` → 3 blocks; texts `intro`, `Alpha: [afbeelding: A]`, `Bravo: -`; html of block 1 contains the `<img`. `<p>`/`<div>`/`<li>` boundaries split too; whitespace-only blocks dropped; an `<img>` without alt uses its file name.
  - `buildHintSplitPrompt` contains every block as `[n] text`, the area names, and explains `-` means no hint.
  - splitter answer cleaning: unknown area dropped; block numbers out of range or duplicated dropped; `none: true` with blocks → `none: false`; an answer with no usable area → throws GeminiError (invalid answer); areas compared case-insensitively.
  - `snippetFor` joins original html in index order.
  - `applyHintSplit`:
    - open cell → becomes none (snippet unset) when split says none; none cell → becomes open with snippet when split gives blocks;
    - solved cell untouched (status, answer, snippet unchanged);
    - an area missing from the split untouched;
    - sets `Article.hintSplitHash = contentHash`, but not when the article's contentHash changed meanwhile;
    - returns the changed areas; board cache invalidated when something changed (assert via `getBoardJson` rebuild or spy).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
  - Blocks: split the HTML at boundaries with a regex on `<br\s*/?>`, `</p>`, `</div>`, `</li>`, `</figure>`, `<hr\s*/?>`, `</h[1-6]>` (keep the closing tag with the preceding block); text = tags stripped (`<img>` → `[afbeelding: alt|filename]`), `&nbsp;` → space, whitespace collapsed; drop blocks whose text is empty and that have no `<img`.
  - Prompt (English instructions, Dutch content): Jotihunt hint = shared intro + per deelgebied (Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, Oscar) an encoded part; "-" or "--" = no hint for that area this round; a part may span several blocks, may be an image, may be introduced as "Alpha en Bravo:" (both get the blocks); intro blocks belong to no area. Ask for JSON `{ "areas": [{ "area": "alpha", "none": false, "blocks": [3, 4] }] }` for every area.
  - Schema `{ areas: array of { area: string, none: boolean, blocks: integer[] } }`, `generateText({ model, prompt, output: Output.object({ schema: jsonSchema(SCHEMA) }), temperature: 0.1, maxRetries: 0, timeout })`, `toGeminiError` on failure, `invalidAnswer()` when nothing usable.
  - Apply: per AreaSplit read the cell; skip it when missing or `solved`; then `HintCell.updateOne({ _id, status: readStatus }, …)` (compare-and-set on the status read, so a solve meanwhile wins); `$set: { status }` + `$set snippet` or `$unset snippet`. Then `Article.updateOne({ id, contentHash }, { $set: { hintSplitHash: contentHash } })`; `invalidateBoardCache()` if any cell changed.
- [ ] **Step 4:** tests PASS; tsc + lint clean.
- [ ] **Step 5: Commit** `feat(hints): AI hint split service (blocks, Gemini split, apply)`.

### Task 2: Job and cron (server)

**Files:** modify `src/services/hint-split.service.ts` (+ tests), create `src/crons/hint-split.cron.ts`, modify `src/crons/schedule.ts`, `src/index.ts` (startup warning text).

**Interfaces:**
```ts
export async function findPendingHintSplits(limit: number): Promise<{ id: number; title: string; content: string; contentHash: string }[]>; // type hint, contentHash string, hintSplitHash != contentHash, newest first
export function createHintSplitJob(opts: { splitter: HintSplitter; areas?: () => Promise<string[]>; beginRun?: () => Tracked; maxAttempts?: number; batch?: number; now?: () => number }): { run(): Promise<{ done: number[]; failed: { id: number; error: unknown }[] }> };
```

- [ ] **Step 1: Tests** — copy the structure of the summary job tests: done path stores (cells changed + hash set), retryable GeminiError pauses 2 min then doubles, non-retryable counts and gives up after 2 for the same content (a content change resets), demo switch (tracked returns undefined) stops the run. `areas` defaults to the area names used by `ensureHintCells` (`getAreaNames` in `article-sync.service.ts` — export it if needed).
- [ ] **Step 2:** FAIL → implement mirroring `createSummaryJob` (share nothing by copy-paste of large blocks if a small shared helper is cleaner; keep the summary job behaviour unchanged).
- [ ] **Step 3:** `src/crons/hint-split.cron.ts` mirroring `article-summaries.cron.ts` (`createModels()`, `models("summary")`, `runTracked` with generation, logs `(CRON) Split hint articles …` / warn on Gemini failures / error on others). Schedule in `schedule.ts`: `cron.schedule("15,35,55 * * * * *", reportCronErrors("hint-split", splitHints), { name: "hint-split", noOverlap: true })`. Startup warning in `index.ts`: append ", and hints are split by rule only".
- [ ] **Step 4:** full suite (expect the known load-flaky demo database-switch timeouts only; rerun `src/demo` alone to confirm), tsc, lint.
- [ ] **Step 5: Commit** `feat(hints): background job lets Gemini correct the hint split`.

### Task 3: "Geen hint" rows can be answered (client)

**Files:** `src/components/intel-window/HintPane.tsx` (worktree `.worktrees/client-ai-hint-split`, branch `feat/ai-hint-split`).

- [ ] **Step 1:** A `none` cell renders as an expandable row like open rows, but dimmed (same muted look as today, e.g. `opacity-60` on the header content, not on the whole frame) with the "geen hint" label in place of "open". Its body: muted `Volgens de hint geen opdracht voor {Area} deze ronde.` (animate in with the body), the snippet via `ArticleHtml` when present, and the same answer field / preview / save / replace-marker flow. After saving, the row is a solved row.
- [ ] **Step 2:** Auto-open logic (`initialOpenArea`, `nextOpenArea`) unchanged — none rows never open by themselves; a mini-grid click on a none cell does open it (check `initialOpenArea`: when the store area is a `none` cell, open it — adjust the helper + its test: requested area wins if it has a cell).
- [ ] **Step 3:** `npm run build && npm run lint && npx --yes bun test`.
- [ ] **Step 4: Commit** `feat(intel): answer a "geen hint" area anyway`.

### Task 4: Real Gemini check + deploy

- [ ] Run the split once against real Gemini (key from the cluster Secret `jotihunt-secret`, never printed or committed) on a throwaway DB with two sample hints (the seed in `.superpowers/sdd/iw/seed.ts` and one with "Alpha en Bravo:" + an image-only area), print the resulting cells. Then merge `feat/ai-hint-split` to main in both repos, push, CI, homelab PR bumping both image digests, squash-merge, Argo refresh, verify rollout + logs.
