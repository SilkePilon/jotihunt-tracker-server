# QR hunts + "Foto bij hunt" switch

2026-10-16, approved by the user. Game starts 17 Oct 2026.

## Why

Jotihunt news (16 Oct, 20:55): foxes no longer hand out a hunt code. A hunter scans the fox team's QR code, logs in
on jotihunt.nl and confirms on a page that needs location permission. The hunt must be confirmed **within 15 minutes**.
Our flow (sticker photo → Gemini reads code + time → HQ types code into jotihunt.nl within 30 min → scraper matches by
code) no longer fits.

## Decisions

- New admin setting **"Foto bij hunt"** (`huntPhoto`, boolean, default **false**). Beheer → Algemeen switch.
- **Photo on:** today's photo flow stays, only the window goes 30 → 15 min.
- **Photo off:** hunters get no camera/photo option at all (web and Android). Flow: "Hunt melden" → fox picker
  (nearest active fox suggested, cooldown/red warnings as today) → "Melden" → saves tap time + GPS (hunt marker, so
  cooldown and prediction keep working) → confirm screen "Scan de QR-code bij de vos en bevestig op jotihunt.nl" with a
  15-min countdown. Reminder after 10 min. No "Ik heb bevestigd" button: the scraper flips it to confirmed.
- Window is 15 min everywhere (both modes).
- UI follows the current app style: M3 tonal surfaces, soft orange primary container, every state change animated
  (motion/react on web), Android M3 Expressive.

## API contract (server)

- `GET /settings/hunt-photo` (any logged-in user or device token) → `{ "enabled": boolean }`.
- `PUT /settings/hunt-photo` (admin) body `{ "enabled": boolean }` (strict boolean) → `{ "enabled": boolean }`.
  Same pattern as `/settings/prediction`. Android reads it with its device token, so the route must accept whatever
  auth the Android app already uses for `GET /hunt-reports`.
- `POST /hunt-reports` multipart: `photo` becomes **optional**. Without a photo: no OCR (ocr status `done`, nothing
  to read), `huntTime` = `takenAt` (accepted by `acceptedTakenAt`) or now, `huntTimeSource` manual. Fields area,
  lng/lat, uploadId, takenAt unchanged. Old Android 1.0.1 keeps sending photos: must still work regardless of setting.
- Hunt report view gets `hasPhoto: boolean`; `photoUrl`/`thumbUrl` are `null` when there is no photo;
  `GET /:id/photo` → 404 for photo-less reports. Status enum names stay the same (`to_submit | overdue | submitted |
  judged`) for compatibility; clients label them per `hasPhoto`:
  - hasPhoto: Te versturen / Te laat! / Ingestuurd / (site status)
  - no photo: Bevestigen / Te laat! / — / Bevestigd (site status, points)
- `SUBMIT_WINDOW_MS` = 15 min; `deadline` = huntTime + 15 min.
- Notifier: warning at 10 min after huntTime (5 min left). Photo-less title
  `Bevestig hunt ${Area} op jotihunt.nl, nog ${minutes} min`, body `Gemeld door ${name}.` Photo reports keep the
  current wording with the new numbers.
- Scraper (`scrapeHunts`, `storeHunts`, `Hunt` model): rows without a hunt code are **kept**. `Hunt.huntCode` becomes
  optional; upsert key = code when present, else area + huntTime (add a unique `siteKey` field, e.g.
  `code:<code>` / `time:<area>:<iso>`). Column layout of jotihunt.nl `/hunts` may change; parse defensively by header
  text when possible and log unknown layouts instead of dropping everything.
- Linking (`hunt-report-sync`): match by normalised code first; otherwise a report without code matches a scraped
  hunt of the same area whose huntTime is within ±15 min of the report's huntTime (closest wins, each scraped hunt
  links to at most one report).
- AI chat rule text (`intel-chat/prompt.ts`): hunt = fysiek contact, scan de QR-code van de vos, bevestig binnen 15
  minuten op jotihunt.nl met locatie; daarna 1 uur dezelfde vos niet hunten.
- Client cooldown already uses own reports' huntTime, so photo-less reports count.

## Web client

- Settings hook for `huntPhoto` (react-query, refetch on focus).
- Beheer → Algemeen: switch "Foto bij hunt" with helper text ("Uit: hunters melden een hunt zonder foto en
  bevestigen hem met de QR-code van de vos op jotihunt.nl.").
- Photo off: `HuntMarkerButton` / any "Hunt registreren" entry shows a hunt icon + "Hunt melden" and opens
  `HuntRegistrationDialog` without a photo (no `HuntPhotoInput` rendered). Dialog text explains the QR step. After
  sending, the dialog swaps (animated) to a confirm state: QR illustration, "Scan de QR-code bij de vos en bevestig
  op jotihunt.nl", 15-min countdown ring/time, "Sluiten".
- Lists/timeline/HQ: photo-less reports show "Bevestigen · nog mm:ss" / "Te laat!" / "Bevestigd"; no sticker hero,
  code pill, OCR re-read, or "Ingestuurd" button for them (show a neutral QR/fox visual instead of the photo).
- `NewHuntToaster`: "nog mm:ss om te bevestigen" for photo-less reports.
- All 30-min texts → 15 min; notification settings text "5 minuten voordat een hunt bevestigd moet zijn" etc.
- Tour texts that say "Maak een foto van een hunt" adapt to the setting or become neutral ("Meld een hunt").

## Android

- Read `GET /settings/hunt-photo` (on start, on resume, with the existing polling refresh); cache last value.
- Photo off: camera FAB becomes a "Hunt melden" FAB (fox/flag icon) that opens the fox picker (HuntReview without
  photo); queue/upload work without a photo part (multipart without `photo`).
- HuntSent: QR instructions + 15-min countdown; local reminder at 10 min ("Bevestig je hunt op jotihunt.nl, nog 5 min").
- All 30-min constants → 15 min; strings drop "code" wording in photo-off mode.
- Version 1.0.2. Publishing needs user approval.

## Out of scope

Scanning the QR inside our app; storing the QR URL; manual "bevestigd" button.
