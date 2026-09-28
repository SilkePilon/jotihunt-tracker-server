# Server-side Hunt OCR (Gemini) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hunters upload only photo + fox team; the server reads the case-sensitive code and handwritten time with Gemini; admins review and correct.

**Architecture:** Server: pure parser/date helpers, a small Gemini REST client, an in-process OCR queue, model/view changes, PATCH + re-read routes. Client: simplified registration, removal of Tesseract, OCR/review states in lists and an admin edit form in the detail view.

**Tech Stack:** Bun 1.4, Express 5, Mongoose 9, axios, bun:test; React 19, Vite 8, shadcn new-york, SWR.

**Spec:** `docs/superpowers/specs/2026-09-29-server-ocr-design.md` (server repo) — the source of truth for fields, rules, copy and API.

## Global Constraints

- Branch `feat/server-ocr` in both repos (checked out). Bun only via Docker (server: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network jotihunt_default -e MONGO_URI_TEST=mongodb://mongodb:27017/jotihunt-test -v "$PWD":/app -w /app oven/bun:1 bun <args>`; client the same without network/Mongo env).
- `GEMINI_API_KEY` / `GEMINI_MODEL` (default `gemini-3.8-flash`) from env; never log, print or return the key (also not in error messages: log only status codes / error class).
- Hunt codes are case-sensitive; `normalizeHuntCode` only strips whitespace.
- Admin-only: PATCH, re-read, status changes, delete. UI copy Dutch. Server style double quotes/printWidth 200; client single quotes.
- Tests never call the real Gemini API (inject a fake client).
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.

---

### Task 1: Server — Gemini reading pipeline, model/view, API

**Files:**
- Create: `src/services/sticker-ocr.helpers.ts` (+ test) — `parseStickerReading(text)`, `resolveReadTime(hhmm, reference)`.
- Create: `src/services/gemini.client.ts` (+ test with a fake axios-like http) — `createGeminiClient({ apiKey, model, http? })` with `readSticker(base64, mimeType)`.
- Create: `src/services/hunt-ocr.service.ts` (+ test, DB) — queue: `createHuntOcr({ reader, loadPhoto, sleep?, onError? })` with `enqueue(id)`, `resumePending()`, `idle()` (promise resolving when the queue is empty, for tests).
- Modify: `src/models/hunt-report.model.ts`, `src/services/hunt-report.helpers.ts`, `src/services/hunt-report.service.ts` (+ tests), `src/controllers/hunt-reports.controller.ts`, `src/routes/hunt-reports.route.ts`, `src/index.ts` (syncIndexes for HuntReport; start queue + `resumePending()` after DB connect), `src/services/leaderboard.service.ts` if needed, `.env.example` + root `.env.example` (`GEMINI_API_KEY=`, `GEMINI_MODEL=gemini-3.8-flash`), `README.md` (Dutch section incl. the free-tier privacy note).

- [ ] **Step 1: Parser + time helpers (TDD).** Reference implementation:

```ts
export interface StickerReading { code: string | null; codeConfidence: number; time: string | null; timeConfidence: number }

const CODE = /^[A-Za-z0-9]{4,12}$/;
const TIME = /^(\d{1,2})\s*[:.;,]\s*(\d{2})$/;
const clamp01 = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Parse Gemini's JSON answer (optionally inside ``` fences); invalid parts become null / 0. Throws on non-JSON. */
export function parseStickerReading(text: string): StickerReading {
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const raw = JSON.parse(json) as Record<string, unknown>;
  const code = typeof raw.code === "string" && CODE.test(raw.code.trim()) ? raw.code.trim() : null;
  let time: string | null = null;
  const match = typeof raw.time === "string" ? raw.time.trim().match(TIME) : null;
  if (match && Number(match[1]) <= 23 && Number(match[2]) <= 59) time = `${match[1].padStart(2, "0")}:${match[2]}`;
  return { code, codeConfidence: code ? clamp01(raw.codeConfidence) : 0, time, timeConfidence: time ? clamp01(raw.timeConfidence) : 0 };
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Most recent occurrence of HH:MM (server local time) relative to `reference`; > 5 min ahead means the previous day. */
export function resolveReadTime(hhmm: string, reference: Date): Date {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const time = new Date(reference);
  time.setHours(hours, minutes, 0, 0);
  if (time.getTime() - reference.getTime() > FUTURE_TOLERANCE_MS) time.setDate(time.getDate() - 1);
  return time;
}
```
Tests: fences; bad code ("JOTIHUNT 2025" with space, "ab") → null; time "11:17", "5.53" → "05:53", "11;17", "25:00" → null, "" → null; confidences clamped / missing → 0; non-JSON throws. resolveReadTime: same day, previous day across midnight, within 5 min tolerance.

- [ ] **Step 2: Gemini client.**

```ts
export interface GeminiHttp { post<T>(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }): Promise<{ data: T }> }
export class GeminiError extends Error { constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); } }

export const STICKER_PROMPT = `...`; // per spec: explain title, case-sensitive printed code, handwritten time; JSON only

export function createGeminiClient({ apiKey, model, http }: { apiKey: string; model: string; http: GeminiHttp }) {
  return {
    async readSticker(base64: string, mimeType: string): Promise<StickerReading> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = {
        contents: [{ parts: [{ text: STICKER_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      };
      let response;
      try {
        response = await http.post<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>(url, body, { headers: { "x-goog-api-key": apiKey }, timeout: 30_000 });
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        throw new GeminiError(`Gemini request failed${status ? ` (HTTP ${status})` : ""}`, !status || status === 429 || status >= 500, status);
      }
      const text = response.data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      try {
        return parseStickerReading(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
```
Never put `apiKey` or the axios error object into messages/logs. Tests with a fake http: request URL/body/header shape; success parse; 503 → retryable; 400 → not retryable; network (no response) → retryable; garbage text → not retryable.

- [ ] **Step 3: Model + view.** Per spec (optional code/time, sources, `ocr` subdocument, non-unique index). `toHuntReportView` adds `huntCode | null`, effective `huntTime`, `huntTimeKnown`, `ocrStatus`, `codeConfidence`, `timeConfidence`, `needsReview`, `duplicateOf` (computed in `listHuntReports` from all reports: earliest other report with the same non-null code). Reports without an `ocr` field → `ocrStatus: "done"`. `huntReportStatus` uses the effective time. `linkScrapedHunts` skips reports without code. `createHuntReport` no longer requires code/time and no longer rejects duplicates; it accepts optional `huntCode`/`huntTime` (manual sources), sets `ocr.status = "pending"` when code or time is missing, and creates the marker at `huntTime ?? now`. Update existing tests accordingly (duplicate test → now flagged via `duplicateOf`, not 409).

- [ ] **Step 4: OCR queue** (`hunt-ocr.service.ts`): one at a time; per report: set `reading`, `attempts++`; read the photo (`loadPhoto(name) → Buffer`), base64; `reader.readSticker`; on success set only non-manual fields, sources `ocr`, confidences, `rawTime`, `readAt`, `status: "done"`, resolve the date with `resolveReadTime(time, createdAt)`, update the linked marker's time; on `GeminiError` retryable and attempts < 3 → wait `[5_000, 20_000][attempts-1]` via injected `sleep` and retry; otherwise `status: "failed"`, `error` (Dutch, no secrets). `reader` null (no key) → failed "Geen GEMINI_API_KEY ingesteld". `resumePending()` enqueues pending/reading. Errors never crash the process (`onError`).

- [ ] **Step 5: API.** Upload route: `huntCode`/`huntTime` optional (validators `.optional()`); after create → `ocr.enqueue(id)` when pending. `PATCH /:id` (admin; `huntCode` optional string 1–64, `huntTime` optional ISO8601) → manual set, clears `needsReview` inputs accordingly, returns view; `POST /:id/read` (admin) → reset non-manual fields to null + `ocr = { status: "pending", attempts: 0 }`, enqueue, return view. Controller builds the Gemini client only when `GEMINI_API_KEY` is set (axios instance), `GEMINI_MODEL ?? "gemini-3.8-flash"`. `index.ts`: after DB connect `await HuntReport.syncIndexes()` (log errors) and `ocr.resumePending()`.

- [ ] **Step 6: Verify + commit.** Full `bun test`, typecheck, lint. Rebuild server; `GET /hunt-reports` 401 without token. Commit: `feat(hunts): server-side OCR of code and handwritten time with Gemini`.

---

### Task 2: Client — simplified registration, review states, admin editing

**Files:** `src/types/HuntReport.ts`, `src/lib/hunt-reports.ts` (+ tests), `src/hooks/hunt-reports.hook.ts` (createReport without code/time; `updateReport(id, { huntCode?, huntTime? })`; `rereadReport(id)`), `src/components/hunts/HuntRegistrationDialog.tsx`, `HuntReportRow.tsx`, `AllHuntsDialog.tsx`, `HuntDetail.tsx`, `HuntStatusBadge.tsx`, new `src/components/hunts/HuntCodeText.tsx` (code / "Wordt gelezen…" / "Onbekend" + Concealed), delete `src/lib/ocr.ts`, remove `cropSticker`/`canvasToBlob` from `src/lib/image.ts`, remove `extractHuntCode`/`codeCandidate`/`voteHuntCode`/`OcrWord` and their tests, `bun remove tesseract.js`.

- [ ] Types per spec view (`huntCode: string | null`, `huntTimeKnown`, `ocrStatus`, `codeConfidence`, `timeConfidence`, `needsReview`, `duplicateOf`).
- [ ] Registration: photo preview, area pills (nearest preselect), kind toggle, "Versturen"; no code/time fields; toast per spec; keep in-flight guards, position logic (marker only when uploaded right away — keep sending position; the 15-min rule no longer applies because the time is unknown at upload: always send the position).
- [ ] Lists/detail per spec (badges "Wordt gelezen…" with spinner, "Controleren", "Zelfde code als hunt van {naam}", "±HH:MM" for unknown time). Blur only applies when a code exists.
- [ ] Detail admin form: code input (case-sensitive, `autoCapitalize="off"`, font-mono) + time HH:MM (reuse the pattern from the old registration time fields) + "Opslaan" (PATCH; resolve HH:MM with `resolveHuntTime(h, m, new Date(report.createdAt))`) + "Opnieuw lezen" (POST read); source line "Gelezen door Gemini (zekerheid 92%)" / "Handmatig ingevuld" / "Lezen mislukt: {error}"? (show generic "Lezen mislukt").
- [ ] `bun test`, build, lint; commit `feat(hunts): hunters only send photo + fox team; review and edit OCR results`.

---

### Task 3: Verification (controller, with the user's key)

- [ ] Rebuild both containers; with `GEMINI_API_KEY` present in `.env`, upload the two sample stickers (`/home/silke/Documents/Jotihunt 2026/.shots/sticker1.jpg`, `sticker2.jpg`) via the API as a temporary admin, wait for OCR, compare with the truth (`GNcrZRZ` 11:17, `Gy3M8XI` 5:53 / 05:53 or 17:53 depending on the reference time), screenshot registration + detail, then delete the test reports **via Mongo only after copying nothing else** — note: API delete removes the photo file, which is fine for these test uploads — and remove the temporary admin + its Traccar device.
