# Hunt Registration — Design

Date: 2026-09-28
Status: approved (brainstorm), pending implementation plan
Repos: server + client, branch `feat/hunt-registration` in both (stacked on `feat/traccar-onboarding`).

## Goal

Hunters register a hunt from their phone right after it happens: take a photo of the hunt sticker, the code is
read with OCR, the hunter fills in the (handwritten) hunt time and the fox team. HQ sees every registration live,
gets a 30-minute submit countdown, submits it by hand on jotihunt.nl and marks it "Ingestuurd". The app links it to
the status and points scraped from jotihunt.nl.

## Game facts (docs/02-game-rules.md §5–6)

- A hunt code must be entered on jotihunt.nl **with the time and a photo of the sticker, within 30 minutes**.
- Submitted hunts cannot be changed.
- After a hunt the group may not hunt the same fox team for 1 hour, counted from the hunt time. Tegenhunts don't
  start this cooldown (existing client rule in `lib/fox-status.ts`).
- The hunt time is written by hand by the fox team, so OCR cannot be trusted for it.

## User decisions

- **Submission is manual by HQ.** The app never submits to jotihunt.nl. (Automatic submission is out of scope:
  the form is unknown until the hunt and mistakes are irreversible.)
- **OCR = Tesseract.js in the browser.** The photo is never sent to a third party. The user always checks the code.
- The hunt time is entered by the user (required), never read by OCR.

## Server

### Model `HuntReport`

```
{
  area: string                 // lowercase area name, like Marker.area
  huntCode: string             // normalised: uppercase, whitespace removed
  huntTime: Date
  kind: 'hunt' | 'tegenhunt'
  photo: string                // file name in the uploads volume
  reportedBy: ObjectId (User), reportedByName: string
  location?: GeoJSON Point     // phone position at registration, when the user allowed it
  submittedAt?: Date, submittedBy?: ObjectId, submittedByName?: string
  site?: { status: string, points: number, seenAt: Date }  // last matching scraped hunt
  createdAt: Date
}
```

Unique index on `huntCode`.

### Derived status (pure function `huntReportStatus(report, now)`)

- `site` present → `judged` (display the raw site status + points; the site's wording is unknown in advance, so no
  mapping is hard-coded).
- else `submittedAt` present → `submitted` ("Ingestuurd").
- else `now ≤ huntTime + 30 min` → `to_submit` ("Te versturen", with `deadline`).
- else → `overdue` ("Te laat!"; submitting stays possible).

### Linking to scraped hunts

After every scraper run, for each scraped hunt: normalise its code the same way and set `site` on the report with
that code. The scraper keeps replacing the `Hunt` collection with the latest 15; `site` on the report persists, so
older reports keep their result.

### Photos

- `multer` upload to the directory `UPLOADS_DIR` (default `/usr/src/app/uploads`), Docker named volume `uploads`.
- Only `image/jpeg`, `image/png`, `image/webp`; max 5 MB; random file name (`crypto.randomUUID()` + extension).
- Served by `GET /hunt-reports/:id/photo` (auth). No public static route.

### Routes (all auth)

- `GET /hunt-reports` → reports newest first (by `huntTime`), each with `status`, `deadline`, `photoUrl`.
- `POST /hunt-reports` (multipart: `photo`, `huntCode`, `huntTime`, `area`, `kind`, `lng?`, `lat?`) →
  created report. `409 { reason: 'duplicate', reportedByName }` when the code exists. `400` for invalid fields or an
  unknown area. When `lng/lat` are given, it also creates a `hunt` marker for the area at that position and time
  (feeds the fox prediction).
- `PUT /hunt-reports/:id/submitted { submitted: boolean }` → any user; sets or clears `submittedAt/By`.
- `DELETE /hunt-reports/:id` → only the reporter or an admin, only while not submitted; deletes the photo file
  and the marker created with it.
- `GET /hunts` (existing) stays; the scraped hunts that match no report are shown in the client as source
  "website".

## Client

### Capture flow

- Mobile: round floating camera button at the bottom right, just above the bottom sheet peek height. It is a
  `<label>` for a hidden `<input type="file" accept="image/*" capture="environment">`, so the native camera opens.
- Desktop: "Hunt registreren" button in the sidebar card opens the same input without `capture` (file picker).
- After a photo is chosen, the registration dialog opens:
  - Photo preview. The photo is downscaled in the browser to max 1600 px on the long side, JPEG quality 0.8,
    before OCR and upload.
  - **Huntcode**: Tesseract.js (`eng`, worker created lazily on first use, character whitelist `A-Z0-9`) runs on
    the downscaled photo; the field shows "lezen…" and is then filled with the longest alphanumeric token of 4+
    characters. Editable; hint "Controleer de code" after OCR, "Code niet gelezen, typ hem over" when nothing
    was found.
  - **Deelgebied**: area pills; preselected = the area whose last observation or predicted zone centre is nearest
    to the phone's position (when geolocation is available), otherwise none.
  - **Tijd van de hunt**: hour and minute fields (24 h), empty, required, with a "Nu" button. The date is the most
    recent occurrence of that time: when HH:MM is more than 5 minutes in the future it means yesterday (the hunt
    runs through the night, e.g. 23:55 registered at 00:10). The resolved date and time are shown below the fields.
  - **Soort**: Hunt / Tegenhunt toggle (default Hunt).
  - Warning (non-blocking) when the area is red or still in cooldown.
  - Save → upload. On failure the dialog stays open with the data and a "Opnieuw proberen" button.
  - 409 duplicate → error "Deze code is al geregistreerd door <naam>".

### Sidebar section `hunts` ("Hunts")

- Added to `SidebarSectionId`, the store defaults and merge; placed under "Hints".
- Collapsed summary: red badge `N te versturen` when any report is `to_submit` or `overdue`, otherwise
  `N hunts · P pt` (points from `site`).
- Open: "Hunt registreren" button, the 3 newest reports (area dot, code, time, status badge, countdown while
  `to_submit`), and "Alle hunts bekijken".
- Rows in `to_submit` / `overdue`: copy-code button and "Ingestuurd" button (undo toast).

### Dialog "Alle hunts"

- Large dialog on desktop, full-height sheet on mobile.
- Totals: hunts and points per area.
- Filters: Alles / Te versturen / Ingestuurd / Beoordeeld.
- Table: thumbnail, area, code, kind, hunt time, reported by, status, points. Scraped hunts without a report are
  included with source "website" (no photo, no actions).
- Row click → detail: large photo + download, copy code, copy time (`HH:MM`), Ingestuurd / Terugzetten,
  Verwijderen (reporter or admin, not submitted).

### Integrations

- Cooldown (`lib/fox-status.ts`): the latest hunt time per area considers both scraped hunts and reports of kind
  `hunt`, so the cooldown starts at registration.
- Toast for all users when a new report appears in the poll: "Nieuwe hunt Alpha – nog 27 min om in te sturen"
  (not for the reporter's own report).
- Polling `GET /hunt-reports` every 10 s via the existing SWR helper; mutate after own actions.
- UI copy Dutch.

## Error handling

- OCR errors never block registration; the code field just stays empty.
- Photo upload limits return `400` with a Dutch message shown in the dialog.
- The scraper link step catches its own errors and does not break the scraper run.

## Testing

Server (`bun test`): status derivation (to_submit / overdue boundary, submitted, judged), code normalisation,
linking scraped hunts to reports, duplicate `409`, delete permissions (reporter / admin / submitted), photo route
requires auth, upload type and size limits, marker created with location.
Client: `bun test` for helpers (code extraction from OCR text, nearest-area choice, countdown/label formatting,
cooldown with reports), build + lint, OCR check with a generated sticker image, headless screenshots of the card,
the dialog, the registration dialog and the mobile camera button above the sheet.
