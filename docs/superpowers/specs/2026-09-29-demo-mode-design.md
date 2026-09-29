# Demo mode — Design

Date: 2026-09-29
Status: approved (brainstorm)
Repos: server + client, branch `feat/demo-mode` in both (server from `feat/server-ocr`, client from `feat/hint-dialog`).

## Goal

An admin switches on "Demo mode" and the whole app shows a realistic, busy Jotihunt in progress (for demos, testing
and training), built from real Jotihunt 2025 content. Switching off returns to the real data exactly as it was.

## Switching (server)

- The real database stores a small `DemoState` document `{ enabled: boolean, enabledAt?: Date, enabledBy?: string }`
  (collection `settings`, key `demo`). It is read at startup: when enabled the server starts in demo mode.
- Demo on: disconnect Mongoose, connect to the demo database (same Mongo URI with database name
  `<realDbName>-demo`, e.g. `jotihunt-demo`), drop that database, copy the real `users` collection into it (so everyone
  keeps logging in), run the demo generator, then serve from it. The switch happens between requests: incoming requests
  wait for the switch (a simple promise gate middleware) so none hits a half-switched connection.
- Demo off: switch back to the real database (the demo database is dropped). Nothing in the real database changes except
  the `DemoState` document.
- While demo is on: the jotihunt.nl crons (areas, articles, hunts scraper, group logos) skip their run; the prediction
  and OCR queue keep working on the demo database. Hunt photos use `UPLOADS_DIR/demo` (cleared on each switch).
- Routes: `GET /demo` (auth) → `{ enabled, enabledAt, startedAt }`; `POST /demo` (admin) `{ enabled: boolean }` →
  same shape after the switch (can take a few seconds). Switching to the current state is a no-op.

## Demo world (generator, deterministic with a fixed seed; times relative to "now")

"Hunt start" = now − 6 h (rounded down to the hour). All generated times stay ≤ now.
- Areas: the 9 fox teams Alpha…Hotel + Oscar; statuses: 6 green (incl. Oscar), 1 orange (onderweg), 2 red, `updatedAt` spread over the last hours.
- Teams: all real teams copied from the real DB (with logos) and assigned to areas geographically: k-means (k = 8) on
  the group coordinates for Alpha…Hotel, sorted west→east/north→south so letters are stable; the 4 groups nearest to the
  centre of all groups get Oscar instead. The home team (HOME_TEAM_API_ID) keeps its computed area.
- Fox routes: per area a walking route that visits that area's groups in nearest-neighbour order starting at a random
  group, moving at 4.5 km/h from hunt start with 10-min stops; Oscar jumps between its groups (OV). Positions along the
  route at any time t are interpolated.
- Articles: the real 2025 articles in `src/demo/data/articles-2025.json` (6 hints, 5 assignments, 4 news) re-timed:
  hints at hunt start + 0 h … + 5 h (on the hour, oldest hint = earliest), assignments/news spread between them, ids
  offset by 800000 (`900000+` is used by seed-hint). They are inserted via the existing article sync so hint cells are
  created as usual.
- Hint cells: for hint hour h the true answer per area = the fox position at that hour in RD, formatted `XXXX YYYY`
  (hectometres). Cell states: hints older than 2 h: solved (checked "Klopt" mostly, one "Twijfel"), with the answer and a
  hint marker; the 1–2 h old hint: mix of solved / solving (claimed by demo users); the newest: mostly open, one solving;
  red areas at the newest hint: "none". Each hint gets 1–3 notes on some cells (short realistic Dutch puzzle notes).
- Markers: hint markers from solved cells (existing solve path or direct insert with the same rules); 4 spots and the
  hunt markers belonging to hunt reports, at the fox position at that time ± 50 m.
- Demo users: 8 hunters (Merida, Mulan, Moana, Tiana, Elsa, Rapunzel, Belle, Pocahontas) with random passwords (not
  shown), not admin, `requiresPasswordChange: false`, each with a simulated tracker `{ deviceId: 900001+, uniqueId,
  vehicle }` (3 car, 3 bike, 2 walking).
- Hunt reports: ~10 by demo hunters, on foxes at their positions at that time, with sticker photos from
  `src/demo/stickers/*.jpg` (code + handwritten time), codes/times read (ocr done, confidences 0.9–0.99), statuses:
  3 judged (site status "Goedgekeurd", points 10 / 5), 3 submitted, 2 to_submit (recent), 1 overdue, 1 needsReview
  (low confidence). Cooldowns follow from the hunt times.
- Simulated trackers (in memory, demo only): `/tracker/devices` and `/tracker/positions` return the 8 demo devices
  (group ids per vehicle from env) moving along the fox-hunting areas: each hunter follows a loop around its assigned
  area's centre at vehicle speed (walk 5, bike 15, car 40 km/h), `lastUpdate` = now for 6 of them, 12 min ago for 2
  (inactive). Battery/accuracy plausible. The leaderboard's Traccar summary uses the simulated distance travelled since
  hunt start (`speed × elapsed`, capped). `/tracker/me` stays real (Traccar) — demo users can't log in anyway.

## Client

- Settings → Admin tools: menu item "Demo mode" with a Switch-style check (DropdownMenuCheckboxItem) reflecting
  `GET /demo`; toggling asks for confirmation (AlertDialog): on — "Demo mode aanzetten? Iedereen ziet dan demo-gegevens.
  De echte gegevens blijven bewaard."; off — "Demo mode uitzetten? De demo-gegevens verdwijnen." With a loading state
  while switching; afterwards a full page reload.
- An orange "DEMO" badge in the sidebar header (next to the countdown) for everyone while demo mode is on; its tooltip:
  "Demo mode: dit zijn geen echte gegevens".
- `useDemo()` hook: SWR `GET /demo` every 30 s (so other users' apps notice and reload when it flips).

## Testing

Server: generator unit tests on pure parts (k-means assignment stable and complete, route interpolation, RD answer
format, cell state mix, hunt report status mix) with a fixed seed; switching tested against the test Mongo (real db
untouched: a document in the real db survives a demo on/off cycle; users copied; crons skip while enabled). Client:
build/lint/tests. Manual: switch on in the app, screenshots of the map, sidebar, hint board, hunts, leaderboard, hunters
dialog; switch off and confirm the real data is back.
