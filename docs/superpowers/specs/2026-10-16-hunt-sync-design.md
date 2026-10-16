# Hunts as a sync with jotihunt.nl (no manual registration)

2026-10-16, design approved by the user (UI picked in the visual companion: option C v3,
`jotihunt-tracker-client/.superpowers/brainstorm/43082-1792187113/content/hunts-sync-c3.html`).
**Blocked on**: a jotihunt.nl login, to see the real `/hunts` page (does it contain location + accuracy?).
Follows `2026-10-16-qr-hunts-design.md` (QR flow + "Foto bij hunt"), which this replaces once it works.

## Why

Since the QR rule, jotihunt.nl stores each hunt itself (infographic "Vossen-QR scannen"): group, fox, device, unique QR
code, registration time as hunt time, location + accuracy, status "Wacht op bevestiging", points. If `/hunts` (or a
detail page) shows that data, the scraper can import every hunt and nobody has to register anything in our app.

## Decisions

- **No manual registration anywhere**: remove "Hunt melden"/"Hunt registreren", camera, photo upload, the
  "Foto bij hunt" switch, the QR confirm step, the HQ "Ingestuurd" flow, the Alle hunts dialog (web) and the hunt
  camera/review/sent screens + queue (Android). Old `HuntReport` data is not migrated (the game hasn't started).
- **Hunts card = sync status** (same language as the Jotiboard/Life360 cards):
  - cookie badge 56 px: green check "Gesynchroniseerd"; spinning sync icon "Synchroniseert…" while a scrape runs;
    amber "!" when the last scrape failed (line: "laatst gelukt 4 min geleden · probeert opnieuw"); grey link icon
    "Niet gekoppeld" when no jotihunt.nl login is set ("Een beheerder koppelt het jotihunt.nl-account in Beheer.").
  - one line: `jotihunt.nl · 12 s geleden · 9 hunts · 70 pnt` (ticks, cross-fades only on state change).
  - result bar: 150 px wide, 10 px high, centred, segments approved (green) / waiting (amber) / rejected (red),
    counts next to it.
  - sync log, no icons: `21:43 ● Alpha binnengekomen`, `21:20 ● Delta goedgekeurd +10`,
    `19:55 ● Echo afgekeurd` (● = area colour dot). Newest first, scrolls for older entries. Clicking an entry
    flies the map to the hunt location.
  - every change animates (new log line slides in, bar segments grow, badge pops on state change).
- Card visible to everyone; the login lives in Beheer (existing `jotihuntWebUsername`/`jotihuntWebPassword`).

## Data

- Scraper (every 60 s, existing cron) reads `/hunts` (+ detail page if location is only there): area, time,
  status, points, QR code/id, device/hunter, lat/lng, accuracy. Exact parsing waits for the real page.
- `Hunt` stores those fields (+ `firstSeenAt`, `statusChangedAt`). Sync events (new / approved / rejected / points
  changed) are derived from these changes and stored as a small `HuntSyncEvent` log (or derived on read).
- Sync state (`lastSuccessAt`, `lastError`, `running`, `configured`) exposed via `GET /hunts/sync`.
- Hunt markers on the map come from synced hunts (location + accuracy circle); cooldown and prediction use them.
- Notifications: new hunt in ("Hunt Alpha binnengekomen"), approved / rejected (existing push channels).
- No hunter name: the site's "apparaat" is the fox's device, so the hunter is unknown.

## Android

- Remove camera FAB and hunt screens; fox cards and widgets show synced hunts and cooldown. New version after 1.0.2.

## Open until we can log in

- Does `/hunts` show location + accuracy, or only a detail page? Which device/hunter info?
- Status texts on the site ("Wacht op bevestiging", approved, rejected wording).
- If the site shows no location: fall back to the QR flow from `2026-10-16-qr-hunts-design.md`.
