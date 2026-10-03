# Tegenhunt alert — design

Date: 2026-10-03

## Goal

When our group gets a tegenhunt (Telegram message with a wind direction), an admin can alert everyone from the
Tegenhunt card in the sidebar, so all hunters know there is a tegenhunt and in which direction to search.

## Decisions

- Text only: no image, no shared map state. The direction is written out with an arrow (`NO ↗`, `noordoost`).
- No time in the alert.
- Own notification type `counter-hunt` with its own sound; users can switch it off in Meldingen.

## Server

- `NOTIFICATION_TYPES` gets `counter-hunt` (optional type, so the prefs validator and push filtering pick it up).
- `buildCounterHuntNotification(direction, from)`:
  title `Tegenhunt! Richting NO ↗`, body `Zoek de sticker binnen 500 m van het clubhuis, richting noordoost.`,
  `urgent: true`, `data: { direction, from }`.
- `POST /admin/counter-hunt` (`verifyToken`, `isAdmin`), body `direction` ∈ {0, 45, …, 315}. Stores the notification,
  pushes it to all subscribers who have the type enabled, returns 201 with the notification view.

## Client

- `NotificationType` / `SoundKey` get `counter-hunt`; new sound `counter-hunt.mp3` (ffmpeg two-tone siren).
- Sound priority: fox-green > counter-hunt > broadcast > deadline > fox-status > hint > article.
- `NOTIFICATION_OPTIONS` gets "Tegenhunt"; `NOTIFICATIONS_PROMPT_VERSION` → 2 so everyone sees the new option once.
- Toast: regular toast with a red border and siren icon (shared helper with the HQ toast, which keeps its indigo border).
- Tutorial sound panel gets a "Tegenhunt" row.
- Tegenhunt card: admin-only button "Waarschuw iedereen" below the direction select; sends the chosen direction after
  a confirm dialog showing the exact alert title.

## Testing

Server: builder text per direction, route validation (bad direction 400, non-admin 403), controller stores + pushes.
Client: sound key and priority for `counter-hunt`.
