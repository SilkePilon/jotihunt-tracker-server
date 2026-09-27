# Hint Board — Design

Date: 2026-09-27
Status: approved (brainstorm), pending implementation plan
Repos: `jotihunt-tracker-server` + `jotihunt-tracker-client` (branch `feat/hint-board` in both)

## Goal

Let a team of ~3–8 solvers at HQ (laptops) coordinate solving the hourly Jotihunt hints:
see every hint split per area, claim a cell, share notes, enter the answer, and have
coordinate answers appear on the map immediately. Scoring window is 20 minutes after
publication, so speed and "who is on what" visibility are the priority.

Out of scope (separate specs later): cipher toolbox, bearing/projection tools, push
notifications, fox-location prediction.

## Background

- One hint article per hour (`/articles`, `type: "hint"`), sometimes extra ones (e.g. "Hint Oscar").
- Article HTML has an intro plus one line per area: `Alpha: <img>` / `Bravo: -` / … / `Oscar: …`.
  `-` or `--` means no hint for that area this round.
- Answer is usually an 8-digit RD coordinate `1234 5678` (= RD x 123400, y 567800), sometimes a word.
- Articles can be edited after publication.
- API: 15 articles per page, newest first, rate limit 30 calls/min.

### Existing problem fixed as part of this work

`crons/jotihunt-articles.cron.ts` fetches only page 1 and does `Article.deleteMany({})` +
`insertMany` every 10 s. During the hunt (60+ articles) older hints fall off page 1 and vanish
from the database. The cron changes to **upsert by Jotihunt `id`, never delete**.

## Sync approach

Polling via SWR (`refreshInterval: 3000`) on the board, with optimistic updates on user actions,
matching the rest of the client. Concurrency safety comes from atomic server-side updates
(`findOneAndUpdate` with a status precondition), not from real-time transport.
Rejected: SSE (extra streaming infra, only non-polling part of app), WebSockets (overkill).

## Data model (server)

### `Article` (changed)

Add `contentHash: string` (sha256 of `content`). Cron upserts on `id`. If the hash changes for a
hint article, its cells get `articleChanged: true`.

### `HintCell` (new, `models/hint-cell.model.ts`)

| field | type | notes |
|---|---|---|
| `articleId` | Number, required | Jotihunt article `id` |
| `area` | String, required | `Alpha` … `Oscar` (same names as `Area`) |
| `publishAt` | Date, required | copied from article |
| `slotTime` | Date, required | `publishAt` floored to the hour; used as marker time |
| `snippet` | String, optional | HTML of this area's line from the article (parser output) |
| `status` | enum `open` / `solving` / `solved` / `none` | `none` = area has no hint this round |
| `claimedBy` | ObjectId → User, optional | |
| `claimedAt` | Date, optional | |
| `answer` | String, optional | raw text as entered |
| `answerKind` | enum `rd` / `text`, optional | |
| `markerId` | ObjectId → Marker, optional | set when an RD answer created a marker |
| `check` | enum `unchecked` / `verified` / `disputed`, default `unchecked` | |
| `checkedBy` | ObjectId → User, optional | |
| `notes` | array of `{ user: ObjectId, text: String, createdAt: Date }` | |
| `articleChanged` | Boolean, default false | |

Unique index on `{ articleId, area }`.

## Components (server)

1. **`services/hint-parser.ts`** — pure function `parseHintArticle(html, areaNames) → Record<area, { snippet: string | null; none: boolean }>`.
   Splits on `<Area>:` markers (case-insensitive, tolerant of surrounding tags/`&nbsp;`).
   An area whose trailing content is only `-`/`--`/whitespace → `none: true`.
   Areas not found → `{ snippet: null, none: false }` (client falls back to full article).
2. **`services/rd-answer.ts`** — pure function `parseRdAnswer(text) → { x, y } | null`.
   Accepts `1234 5678`, `12345678`, `123400 567800`, extra whitespace/`,`/`;`. 4-digit halves are
   ×100. Validates bounds: `0 ≤ x ≤ 290000`, `290000 ≤ y ≤ 630000` (same as `HintEntryCard`).
   RD→WGS84 conversion uses `proj4` with the same RD definition as the client (add `proj4` to server deps).
3. **Articles cron (changed)** — upsert articles; for each `type === "hint"` article without cells,
   create one cell per known area (names from the `Area` collection; fall back to Alpha–Hotel + Oscar if empty) using the parser. Existing cells are
   never overwritten except `articleChanged`.
4. **`controllers/hints.controller.ts` + `routes/hints.route.ts`**, all behind `verifyToken`:

| method + path | body | behaviour |
|---|---|---|
| `GET /hints/board` | – | `{ articles: [{ id, title, publishAt, content }], cells: HintCell[] }` for hint articles, newest first, with `claimedBy`/`checkedBy`/`notes.user` populated to `{ _id, name }` |
| `POST /hints/:articleId/:area/claim` | – | atomic: only if `status === "open"` or claimed by self → `solving`. Else 409 `{ message, claimedBy }` |
| `POST /hints/:articleId/:area/release` | – | only claimer or admin → back to `open` |
| `POST /hints/:articleId/:area/solve` | `{ answer: string, replaceMarker?: boolean }` | see "Solve flow" |
| `POST /hints/:articleId/:area/check` | `{ check: "verified" \| "disputed" \| "unchecked" }` | sets `check`, `checkedBy` |
| `POST /hints/:articleId/:area/notes` | `{ text: string }` (1–1000 chars) | appends note |
| `POST /hints/:articleId/:area/status` | `{ status: "open" \| "none" }` | manual override (e.g. parser wrong) |

Validation with `express-validator` via existing `validate.middleware`. 404 when cell doesn't exist.

### Solve flow

1. `parseRdAnswer(answer)`. If null → store as `answerKind: "text"`, `status: "solved"`, no marker.
2. If RD: look for an existing `Marker` with `type: "hint"`, same `area`, same `time` (= `slotTime`).
   - Exists and it is this cell's own `markerId` → update its location.
   - Exists, not ours, and `replaceMarker !== true` → 409 `{ message, existingMarkerId }`.
   - Otherwise (or `replaceMarker === true`, which deletes the old one) → create marker.
3. Set `answer`, `answerKind: "rd"`, `markerId`, `status: "solved"`, reset `check` to `unchecked`.
4. Anyone can solve any cell (claiming is a coordination aid, not a lock), so a second solver can correct an answer.

## Components (client)

1. **`hooks/hints.hook.ts`** — `useHintBoard()` (SWR `/hints/board`, 3 s refresh) plus mutation helpers
   `claim / release / solve / setCheck / addNote / setStatus` with optimistic `mutate`.
2. **`pages/Hints.tsx`** at route `/hints` (auth-protected, same as `/`), linked from the main menu.
3. **`components/hints/HintGrid.tsx`** — rows = hint articles (newest on top), columns = areas.
   Cell shows status colour (open grey, solving amber, solved green, none muted/striped),
   claimer name, check badge (✓ / ⚠), and a countdown `20:00 → 0:00` from `publishAt`
   (red under 5 min; hidden when solved or none).
4. **`components/hints/HintCellPanel.tsx`** — side sheet on cell click: area snippet (sanitised HTML,
   images zoomable) or full article when `snippet` is null; "article changed" banner; Claim/Release;
   answer input + Solve (shows parsed RD preview `x, y → lat, lng` before submit); on 409 marker
   conflict, confirm dialog "Replace existing hint marker?"; Verify / Dispute buttons; notes list +
   add note; "Show on map" navigates to `/` and flies to the marker.
5. **New hint alert** — when the board gains a new article id, play existing `hint-alert.mp3`
   (respecting existing sound setting) and toast.

HTML from Jotihunt is rendered through a sanitiser (DOMPurify; allow `img`, `a`, basic formatting).

## Error handling

- 409 on claim conflict → toast "Already claimed by <name>", board refreshes.
- 409 on marker conflict → confirm dialog, resend with `replaceMarker: true`.
- 400 validation errors → inline field error.
- Network failure → SWR keeps last data; toast on failed mutation and roll back the optimistic update.
- Parser failure never blocks: cells exist with `snippet: null`.

## Testing

Server, `bun test` (add `test` script):
- `hint-parser.test.ts`: 2025 example from `docs/03-api.md`, `-`/`--` lines, `&nbsp;`, missing areas, lowercase area names, extra Oscar article.
- `rd-answer.test.ts`: all accepted formats, bounds rejects, word answers.
- `hints.controller.test.ts` against a real Mongo (docker) or `mongodb-memory-server`: concurrent claims → exactly one 200 and one 409; solve creates marker; marker conflict 409; replaceMarker path; articles cron upsert keeps old hints.

Client: `bun run build` + lint; manual run against local Docker stack with a seeded fake hint article
(`src/scripts/seed-hint.ts` on server) to click through claim → solve → marker on map with two browser sessions.

## Rollout

Feature branch `feat/hint-board` in both repos, stacked on `chore/upgrade-deps`.
