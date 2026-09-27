# Traccar Onboarding Card — Design

Date: 2026-09-28
Status: requirements from the user (2026-09-27, see decisions below); details decided by Claude while the user was
away ("continue on your own"). To be reviewed by the user.
Repos: server + client, branch `feat/traccar-onboarding` in both (stacked on `feat/fox-prediction`).

## Goal

Let every user connect their phone as a live GPS tracker with minimal effort: the sidebar shows a card with a QR
code that the Traccar Client app scans to load all settings. The app then detects that this user's phone is
sending locations, marks the card "Verbonden" and collapses it; opened again it shows stats. A step-by-step guide
dialog helps less tech-savvy users.

## User decisions

- Card is shown to **every** logged-in user (no opt-out), open until that user is connected.
- The user picks their vehicle (Lopend / Fiets / Auto / Motor) in the card, changeable anytime; the backend moves
  the Traccar device to the matching Traccar group (which drives the map icon).
- The server address in the QR code comes from a new `.env` setting `TRACCAR_CLIENT_URL`
  (e.g. `http://tracker.jouwscouting.nl:5055`). Missing → card shows a configuration warning instead of a QR.

## Traccar Client configuration format (verified in traccar/traccar-client source)

`ConfigurationService.applyUri`: for an `http(s)` URI the server URL is `origin + path` and settings come from the
query string; for any other scheme the server URL is the `url` query parameter. Keys: `id`, `accuracy`
(`highest|high|medium|low`), `distance`, `interval`, `angle`, `heartbeat` (ints), `buffer`, `wakelock`,
`stop_detection`, `prefer_platform_providers` (`true|false`). The app registers the deep-link scheme
`org.traccar.client` (Android intent filter + iOS URL scheme) and applies incoming links the same way.

- QR payload: `${TRACCAR_CLIENT_URL}?id=<uniqueId>&accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true`
  (the same settings the README recommends).
- Deep link (for users already on their phone): `org.traccar.client://?url=<encoded TRACCAR_CLIENT_URL>&id=…&<same settings>`.

## Server

- `User` gets optional `tracker: { deviceId: number, uniqueId: string, vehicle: 'walking'|'bike'|'car'|'motorcycle' }`.
- `uniqueId` = `jh-` + last 10 hex chars of the user's `_id` (stable, not personal).
- Traccar group ids from the existing env vars `GROUP_WALKING_ID`, `GROUP_BIKE_ID`, `GROUP_CAR_ID`,
  `GROUP_MOTORCYCLE_ID` (already in the shared root `.env`); missing id → device without group.
- Service `tracker-onboarding.service.ts` (Traccar calls behind the existing `traccarr.service.ts` axios client):
  - `ensureDevice(user)`: if `user.tracker` missing or the device no longer exists → find device by uniqueId
    (`GET /api/devices?uniqueId=`) or create it (`POST /api/devices { name: user.name, uniqueId, groupId }`), store on user.
  - `setVehicle(user, vehicle)`: `PUT /api/devices/:id` with the full device object and the new `groupId`.
  - `status(user)`: device + latest position (`GET /api/positions?deviceId=`), connected = device `lastUpdate`
    within 5 minutes (same rule as "Actieve hunters"); stats: last update, speed (knots → km/h), battery
    (`attributes.batteryLevel`), accuracy (m), distance today (`GET /api/reports/summary?deviceId&from=<today 00:00>&to=<now>`
    → `distance` m; omitted when the call fails).
- Routes (auth): `GET /tracker/me` →
  `{ configured, reason?, qrUrl?, deepLink?, uniqueId?, vehicle?, connected, stats? }` (creates the device lazily);
  `PUT /tracker/me/vehicle { vehicle }` → same shape. `configured: false` with `reason` when
  `TRACCAR_CLIENT_URL` / `TRACCARR_API_URL` / `TRACCARR_API_TOKEN` is missing or Traccar is unreachable
  (no 500s for these cases).
- `.env.example` (server + root) gets `TRACCAR_CLIENT_URL=`; README (Dutch) documents it next to the Traccar section.

## Client

- New sidebar section `tracking` ("Mijn tracker"), directly above "Actieve hunters", added to the sidebar store
  defaults (open) and merge.
- Auto open/collapse: while `connected === false` the section is forced open on load; when `connected` flips to
  true during the session the section collapses once (user can reopen). Collapsed summary: `Verbonden ✓` badge or
  `Niet verbonden`.
- Not connected:
  - QR code (client-side generated SVG via the `qrcode` package, ~180 px, white background for scanning in dark mode),
  - vehicle choice (shadcn `ToggleGroup`: Lopend / Fiets / Auto / Motor),
  - short text: "Scan deze code met de Traccar Client-app",
  - on phones: button "Open in Traccar-app" (deep link),
  - button "Uitleg stap voor stap" → guide dialog.
- Connected: stats (laatste update, snelheid, batterij, nauwkeurigheid, afstand vandaag), vehicle choice, and a
  "Opnieuw koppelen" button that reveals the QR again.
- Not configured: muted text "Live tracking is nog niet ingesteld" (+ for admins: "Vul TRACCAR_CLIENT_URL en de
  Traccar-token in .env in").
- Guide dialog (Dutch, simple wording, numbered steps with icons):
  1. Installeer "Traccar Client" (links: Google Play `org.traccar.client`, App Store `id843156974`).
  2. Open de app en tik op het QR-icoon (instellingen → QR-code scannen) — or on this phone: "Open in Traccar-app".
  3. Scan deze QR-code (same QR shown in the dialog).
  4. Geef locatie-toestemming "Altijd toestaan" en zet batterijbesparing voor Traccar uit.
  5. Zet de schakelaar "Continu volgen / Service status" aan.
  6. Wacht tot hieronder "Verbonden ✓" verschijnt (live status in the dialog).
- Polling `GET /tracker/me` via SWR: every 10 s while not connected, 30 s when connected.

## Testing

- Server `bun test`: uniqueId derivation, QR/deep-link URL building (encoding), vehicle → group mapping,
  connected rule (5 min), stats mapping (knots → km/h, battery, missing fields); Traccar HTTP calls mocked via an
  injected client; route returns `configured: false` without env.
- Client: build + lint; pure helpers (label formatting) tested with `bun test`; headless screenshots of the card
  (not configured, not connected with QR, connected) and the guide dialog, desktop + mobile sheet.
- Manual on the local stack: set `TRACCAR_CLIENT_URL=http://<LAN-IP>:5055`, create a Traccar API token, scan the QR
  with a phone — or simulate a phone with an OsmAnd-protocol request
  (`curl "http://localhost:5055/?id=<uniqueId>&lat=52.2&lon=5.9&timestamp=<unix>"`) and confirm the card turns
  "Verbonden ✓".
