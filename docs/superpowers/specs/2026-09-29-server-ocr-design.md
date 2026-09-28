# Server-side hunt OCR with Gemini — Design

Date: 2026-09-29
Status: approved (brainstorm)
Repos: server + client, branch `feat/server-ocr` in both (stacked on `feat/ocr-case`).

## Goal

Hunters only take a photo and pick the fox team (and Hunt/Tegenhunt). The server reads the case-sensitive hunt code
and the handwritten time from the photo with Google Gemini and fills them in. Admins (HQ) check and correct.

## Decisions

- Engine: Gemini API, `GEMINI_API_KEY` + `GEMINI_MODEL` (default `gemini-3.8-flash`) in `.env`. Key never logged.
  Photos are sent to Google (on the free tier Google may use them to improve products — documented in README).
- The in-browser Tesseract OCR is removed (dependency, helpers, sticker preview).
- Duplicate codes no longer block an upload; they are flagged.

## Server

### Model changes (`HuntReport`)

- `huntCode`: optional (null until read); index kept but **not unique** (startup runs `HuntReport.syncIndexes()` so
  the old unique index is dropped).
- `huntTime`: optional (null until read or entered).
- `huntTimeSource`, `huntCodeSource`: `"ocr" | "manual"` (optional).
- `ocr`: `{ status: "pending" | "reading" | "done" | "failed", attempts: number, codeConfidence?: number,
  timeConfidence?: number, rawTime?: string | null, error?: string, readAt?: Date }`.
- Existing reports (entered by hand before this change) are treated as `ocr.status: "done"` with manual sources.

### Derived view fields (JSON to the client)

- `huntCode: string | null`, `huntTime: string` = effective time (`huntTime ?? createdAt`), `huntTimeKnown: boolean`.
- `status`/`deadline` computed from the effective time (unchanged rules).
- `ocrStatus`, `codeConfidence`, `timeConfidence`.
- `needsReview: boolean` = OCR failed, or code missing, or time unknown, or a confidence < 0.7 on an OCR-sourced
  field; false once both fields are manual or confident.
- `duplicateOf: { id, reportedByName } | null` = an older report with exactly the same code.

### Reading pipeline

- `GeminiClient.readSticker(jpegBase64, mimeType) → { code: string | null, codeConfidence: number, time: string | null,
  timeConfidence: number }` via `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  with header `x-goog-api-key`, one text part (the prompt) + one `inline_data` image part,
  `generationConfig: { responseMimeType: "application/json", temperature: 0 }`, timeout 30 s.
- Prompt (English, precise): the photo shows a Jotihunt sticker; printed title "JOTIHUNT <year>"; below it the
  printed hunt code (4–12 letters/digits, **case-sensitive**, never the title or year); a handwritten time (pen,
  often blue, may overlap the text) in H:MM / HH:MM (24 h; separators like ":", ".", ";" possible). Return only JSON
  `{"code": string|null, "codeConfidence": 0..1, "time": "HH:MM"|null, "timeConfidence": 0..1}`; null when unreadable.
- Parser (pure, unit tested): accepts the JSON (also inside ```json fences), code must match `^[A-Za-z0-9]{4,12}$`
  (else null), time normalised to `HH:MM` from `^(\d{1,2})\s*[:.;,]\s*(\d{2})$` with 0–23 / 0–59 (else null),
  confidences clamped 0..1 (missing → 0).
- Date of the time: the most recent occurrence of HH:MM relative to the report's `createdAt` (same rule as the
  client: > 5 min in the future → previous day), server local time (TZ Europe/Amsterdam in Docker).
- Queue: in-process, one photo at a time; on startup re-queues reports with `ocr.status` pending/reading. Up to 3
  attempts per photo for network errors / 429 / 5xx (backoff 5 s, 20 s); invalid response or 4xx → failed.
  No key configured → `failed` with error "Geen GEMINI_API_KEY ingesteld".
- On success: set code/time (only fields not set manually), sources `ocr`, confidences; move the linked hunt marker's
  time to the read time.

### API

- `POST /hunt-reports` (multipart): `photo`, `area`, `kind`, optional `lng`/`lat` → `201` report with
  `ocrStatus: "pending"`; the reading starts in the background. Marker time = upload time until the time is read.
- `PATCH /hunt-reports/:id` (admin): `{ huntCode?: string, huntTime?: ISO }` → sets the field(s) with source `manual`.
- `POST /hunt-reports/:id/read` (admin): reset OCR for the fields that are not manual and queue again → report.
- Status/delete rules unchanged (admin only).
- Leaderboard, cooldown and scraper linking work with the effective values (a report without code can't link).

## Client

- Registration dialog: photo preview, fox team pills (nearest-area preselect as now), Hunt/Tegenhunt, "Versturen".
  Success toast: "Hunt verstuurd" / "De code en tijd worden nu gelezen." Removed: code field, time fields, OCR,
  sticker preview, tesseract.js dependency and its helpers (`lib/ocr.ts`, `cropSticker`, `extractHuntCode`,
  `codeCandidate`, `voteHuntCode`).
- Everywhere a code is shown: `null` → "Wordt gelezen…" (ocr pending/reading) or "Onbekend" (failed); blur rules
  unchanged for known codes. Time: unknown → "±HH:MM" (upload time) with title "Tijd nog niet gelezen".
- Badge "Controleren" (amber outline) next to the status when `needsReview`; "Zelfde code als hunt van {naam}" when
  `duplicateOf`.
- Detail view (admins): code and time as editable fields (code input case-sensitive, time HH:MM) with "Opslaan",
  plus "Opnieuw lezen"; shows "Gelezen door Gemini (zekerheid 92%)" or "Handmatig ingevuld". Non-admins see values
  read-only.
- Cooldown uses `huntTime` (effective) as now.

## Testing

Server: parser cases (fences, bad code, time variants "11:17", "5.53", "11;17", "25:00" → null), date resolution,
queue (success, retries on 5xx/network, fail on 4xx/invalid, no key), needsReview/duplicateOf derivation, PATCH and
re-read rules (manual fields not overwritten), startup re-queue. Real call only as a manual check with the user's
key on the two sample photos (not in the test suite). Client: build/lint/tests; screenshots of the simplified
registration and the admin detail editing.
