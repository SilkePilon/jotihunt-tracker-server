# Happy hour — Design

Date: 2026-10-13
Status: approved in brainstorm (mockup `.superpowers/brainstorm/3076851-1791876566/content/happy-hour.html`; picked W1, A1, A2, A4)
Depends on: `2026-10-13-telegram-tegenhunt-design.md` (Telegram listener, `TelegramMessage` kind `happy-hour`)
Repos: server, web client, Android app (`jotihunt-tracker-android`)

## Goal

Happy hour = hunts count **double** (not tegenhunts), announced shortly beforehand (rules §8). When @Jotihunt_bot
sends a happy-hour message, everyone gets a notification and the web and Android apps show it while it runs.

## Server

- On a `happy-hour` bot message: `parseHappyHourWindow(text, receivedAt)` → `{ startsAt, endsAt, parsed: boolean }`
  (Europe/Amsterdam):
  - "van 21:00 tot 22:00", "21:00 - 22:00", "21.00–22.00", "tussen 21 en 22 uur" → both times;
  - "tot 22:00" / "tot 22 uur" → start = received, end = that time;
  - "om 21:00" / "vanaf 21:00" → start = that time, end = start + 60 min;
  - "het komende uur", nothing found → start = received, end = received + 60 min (`parsed: false`).
  - Times earlier than `receivedAt − 1 h` roll to the next day; end before start rolls end to the next day.
- Stored as model `HappyHour` (`startsAt`, `endsAt`, `text`, `telegramId` unique, `parsed`). A newer message that
  overlaps an existing window updates that window (no duplicate alerts).
- Notifications (new type `happy-hour`, added to `NOTIFICATION_TYPES` and the client/Android type lists):
  1. On the message: urgent push with sound `happy-hour` → title "Happy hour! Hunts tellen dubbel",
     body "Van 21:00 tot 22:00. Tegenhunts tellen niet mee." (or "Vanaf nu tot 22:00 …" when it starts now).
  2. At `startsAt` when it was in the future: push "Happy hour begint nu" (with sound).
  3. At `endsAt`: non-urgent, silent "Happy hour voorbij" / "Hunts tellen weer normaal."
  Scheduled with a small in-process timer service rebuilt from Mongo on boot (one server replica).
- `GET /happy-hour` (any logged-in user) → `{ state: "none" } | { state: "upcoming" | "active", startsAt, endsAt,
  text }`; ended windows return `none`.
- Sound: reuse the site's `broadcast` sound file under the key `happy-hour` (own key so it can be changed later).

## Web (W1)

- Floating pill centred at the top of the map (right of the sidebar on desktop, below the top controls on mobile),
  amber `#f59e0b` with dark text `#1c1300`, Material `celebration` glyph, flat (no shadow):
  - active: "Happy hour · 2× punten · nog 34 min" (minutes tick);
  - upcoming: "Happy hour om 21:00 · over 12 min".
  Tap → popover with "Hunts tellen dubbel van 21:00 tot 22:00. Tegenhunts tellen niet mee." and the bot text.
- Data `useHappyHour()` SWR on `/happy-hour` (30 s; 10 s within 2 min of a boundary) + revalidate on a
  `happy-hour` notification. Notification settings list gets "Happy hour" (description "Als er een happy hour
  begint: hunts tellen dan dubbel.").
- Hidden when `state: none`.

## Android

- A1: amber chip "2× · 34 min" (upcoming: "2× om 21:00") next to the "Vossen" title in the bottom sheet.
- A2: while active, an ongoing notification (Live Update / progress-style, `ProgressStyle` on Android 16, fallback
  ongoing notification with progress bar on older) "Happy hour · hunts tellen dubbel", "21:00 – 22:00 · nog 34 min";
  removed at the end. Status-bar chip text "34m" where the platform supports promoted ongoing notifications.
- A4: fox widgets get an amber outline and a "2×" chip while active.
- Data: poll `/happy-hour` together with the existing notification polling; `happy-hour` notifications use the new
  sound/channel.

## Testing

- Server unit: `parseHappyHourWindow` cases above (incl. midnight roll-over, no times), window merge, scheduler
  fires start/end once, `/happy-hour` states.
- Web unit: pill text helper (active/upcoming, minutes). Manual: pill states in light/dark, mobile width.
- Android: unit for the chip text; emulator check of the ongoing notification and widget outline.
