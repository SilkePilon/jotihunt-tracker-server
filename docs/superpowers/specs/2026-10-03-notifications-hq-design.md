# Notifications (push + sounds) and HQ wall display — Design

Date: 2026-10-03
Status: approved (brainstorm), pending implementation plan
Repos: server + client, branch `feat/notifications` in both.
Background: `docs/feature-suggestions.md` (roothaan/jotihunt-site comparison), items 2, 3 and 5.

## Goal

Everyone gets told — by push on their phone and by a sound + toast in the open app — when something happens
that needs action: a fox area changes status (above all: turns green), a new hint or opdracht/news article is
published, a registered hunt is about to miss its 30-minute submit deadline, or an admin broadcasts a message.
HQ gets a fullscreen wall display (`/hq`) for the TV with map, area tiles, hunt feed and loud full-screen alerts.

## User decisions

- **Event types:** fox status change (all changes; to-green is urgent, "Jagen mag!"), new hint article, new
  opdracht/news article, hunt deadline nearing, admin broadcast.
- **Opt-out:** every type is on by default. On first open (after the tour) a "Meldingen" dialog lets the user
  switch types off; the same switches live in Settings. The switches control both push and in-app sound.
  Plus one master "Geluid" mute (in-app sound only).
- **Hunt deadline:** one warning at 10 minutes left (20 minutes after the hunt), only if not marked submitted.
  Sent to everyone who has the type on, not only admins.
- **No double alert:** when an app window is focused the service worker shows no system notification; the app
  plays the sound and shows the toast instead.
- **Sounds:** distinct per type.
- **Broadcast:** admins can send free text to everyone.
- **HQ wall:** admin-only route, layout "map left, panel right", plays sounds and shows a full-screen colored
  banner per event.
- **Architecture:** server-side event feed (approach A). One notifier job detects events and stores them; push
  and in-app alerts are both fed from that store. Polling, no websockets (matches the rest of the app).

## Server

### Models

`models/notification.model.ts` — `Notification`
- `type`: `fox-status` | `hint` | `article` | `hunt-deadline` | `broadcast`
- `title`, `body`: Dutch, ready to show
- `data`: free object (`area`, `status`, `previousStatus`, `articleId`, `huntReportId`, `url`)
- `urgent`: boolean (to-green, broadcast)
- `createdAt` (index). TTL index of 48 hours so the collection stays small.

`models/push-subscription.model.ts` — `PushSubscription`
- `user` (ObjectId, ref User), `endpoint` (unique), `keys.p256dh`, `keys.auth`, `userAgent`, `createdAt`.

`models/user.model.ts` — add `notificationPrefs`:
- `disabledTypes: string[]` (default `[]`; opt-out), `promptedVersion: number` (default 0; the client shows the
  Meldingen dialog when lower than its `NOTIFICATIONS_PROMPT_VERSION`).
- Preferences live on the user (not the subscription) so they apply to all of the user's devices and to in-app
  sounds.

`models/notifier-state.model.ts` — `NotifierState` (single document)
- `areaStatus: Map<string, string>` — last seen status per area
- `lastArticleId: number` — highest article id seen
- `initialized: boolean`

`models/hunt-report.model.ts` — add `deadlineWarnedAt: Date` (optional).

### Notifier

`services/notifier.helpers.ts` — pure, unit-tested:
- `diffAreaStatus(previous, current)` → list of `{ area, from, to }`. Areas missing from `current` are ignored
  (the areas cron does deleteMany + insertMany, so a read can see a partial list). Unknown previous = no event.
- `newArticles(articles, lastArticleId)` → articles with a higher id, sorted by id.
- `dueDeadlineWarnings(reports, now)` → reports where `submittedAt` is unset, `deadlineWarnedAt` is unset,
  `now - (huntTime ?? createdAt) >= 20 min` and `< 30 min`. (Past 30 minutes a warning is useless.)
- `buildFoxStatusNotification`, `buildArticleNotification`, `buildDeadlineNotification` → title/body/urgent.
  Examples: "GROEN: Alpha — jagen mag!", "Alpha is nu oranje", "Nieuwe hint", "Nieuwe opdracht: <title>",
  "Hunt Bravo moet over 10 min ingestuurd zijn".
- Article type mapping: `type === "hint"` → `hint`; everything else (`assignment`, `news`) → `article`.

`services/notifier.service.ts` — `runNotifier()`:
1. Load `NotifierState`, current `Area`s, articles with id > `lastArticleId`, open hunt reports.
2. If not `initialized`: store the current state, set `initialized`, send nothing (no flood after a fresh
   start; same idea as the client hint hook skipping the first load).
3. Otherwise create a `Notification` per event, update state; mark warned reports with `deadlineWarnedAt`
   using a conditional update (`deadlineWarnedAt: null` in the filter) so two runs never both warn.
4. For each created notification call `push.service.sendToAll(notification)`.

`crons/notifier.cron.ts` — every 10 s (`*/10 * * * * *`), wrapped like the other crons. Runs in demo mode too:
it reads the active database, so demo areas/articles/hunts produce alerts. A demo switch resets
`NotifierState.initialized` (state is per database, so this happens naturally).

### Push

Dependency: `web-push`.
Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:...`). Added to `.env.example`.
Missing keys → push disabled with one warning log; feed and in-app sounds still work; `/push/vapid-key`
returns 404 so the client hides the push part of the dialog.

`services/push.service.ts`:
- `sendToAll(notification)`: load subscriptions with their user's `disabledTypes`; skip users who disabled the
  type (`broadcast` cannot be disabled). Payload JSON: `{ id, type, title, body, urgent, url }`, TTL 15 min,
  `urgency: "high"` for urgent.
- Send in parallel (bounded, e.g. 10 at a time). On 404/410 delete the subscription. Other errors are logged.

### Routes

- `GET /notifications?since=<ISO>` (verifyToken) → notifications newer than `since`, max 50, oldest first.
  Without `since` → `{ notifications: [], serverTime }` so a client starts from "now" and never replays old
  events. Response always includes `serverTime` for the next `since`.
- `GET /push/vapid-key` → `{ publicKey }` or 404.
- `POST /push/subscribe` (verifyToken) body: browser `PushSubscription` JSON → upsert by endpoint, set user.
- `DELETE /push/subscribe` (verifyToken) body `{ endpoint }`.
- `GET /notifications/preferences`, `PUT /notifications/preferences` (verifyToken) body
  `{ disabledTypes, promptedVersion? }` validated against the type list.
- `POST /admin/broadcast` (verifyToken + isAdmin) body `{ message }` (1–200 chars) → creates a `broadcast`
  notification titled "Bericht van HQ" with the admin's name, and pushes it.

## Client

### Service worker

`public/push-sw.js`, loaded via `workbox.importScripts: ['push-sw.js']` in `vite.config.ts` (generateSW stays).
- `push`: parse payload; `clients.matchAll({ type: 'window', includeUncontrolled: true })`; if any client is
  `focused`, do nothing (the app handles it); else `showNotification(title, { body, icon, badge, tag: type+id,
  requireInteraction: urgent, data: { url } })`.
- `notificationclick`: focus an existing window (navigate to `url` if given) or open one.

### Notification feed

`hooks/notification-feed.hook.ts` — mounted once in `Layout` (and in the HQ page):
- SWR polls `/notifications?since=` every 5 s; first call has no `since` (starts at server time).
- For each new notification: skip if its type is in the user's `disabledTypes`; else play the sound for its
  type (unless master mute) and show a sonner toast (urgent → longer duration, prominent styling).
- Exposes an `onNotification` callback option so the HQ page can show its banner.
- The existing hint sound in `next-hint.hook.ts` is removed (the feed now plays it), the countdown/highlight
  stays. `NewHuntToaster` stays as is.

`lib/notifications.ts` — type list, Dutch labels/descriptions, sound per type, `shouldAlert(type, prefs)`
(pure, tested).

Sounds in `assets/audio/` (generated with ffmpeg, short, normalised):
- `fox-green.mp3` urgent rising siren, `fox-status.mp3` two-tone beep, `hint-alert.mp3` existing,
  `article.mp3` soft chime, `deadline.mp3` three warning beeps, `broadcast.mp3` attention tone.

### Preferences and push subscription

`hooks/notification-prefs.hook.ts`: SWR on `/notifications/preferences`, `update(disabledTypes)`.
`stores/settings.store.ts`: add `soundMuted: boolean` (local only).
`lib/push.ts`: `isPushSupported()`, `isIosNotInstalled()`, `subscribePush()` (permission →
`registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → POST),
`unsubscribePush()`.

`components/notifications/NotificationsDialog.tsx` ("Meldingen"):
- A switch per type (label + one-line description), all on by default from the server prefs.
- Push block: if supported and VAPID key present → "Opslaan" saves prefs, then requests permission and
  subscribes. Denied permission → note how to enable it in browser settings; sounds still work.
  iOS not installed → explains "Zet de app op je beginscherm voor pushmeldingen".
- Shown automatically once after the tour finishes (or on open if the tour is already done) when
  `promptedVersion < NOTIFICATIONS_PROMPT_VERSION`; closing it saves `promptedVersion`.
- Opened from Settings via a "Meldingen" item; Settings also gets the "Geluid" mute switch.

`components/admin/BroadcastDialog.tsx`: text field + send, from admin tools in Settings.

### HQ wall display

Route `/hq` inside the auth outlet but outside `Layout`'s sidebar UI; non-admins are redirected to `/`.
Settings gets an admin item "HQ-scherm" that opens it in a new tab.

`pages/Hq.tsx` — landscape grid, map ~65% left, panel right:
- Map: existing `Map` with teams, markers, predictions, devices layers; interactions disabled, auto-fit to the
  play area.
- Panel top: big clock (HH:MM:SS) and next-hint countdown (reuse `useNextHint` label).
- Area tiles: one per area — status color, hunt cooldown (`lib/fox-status.ts`), last hint and hunt time,
  prediction confidence (if prediction enabled).
- Hunt feed: latest ~6 hunt reports with deadline status (`HuntStatusBadge`) and total points.
- Latest opdracht/news: title + time + deadline (`endTime`) countdown if present.
- Alerts: `useNotificationFeed({ onNotification })` → sound + full-screen colored banner for 8 s (green for
  to-green, status color for other fox changes, blue for articles, orange for deadline, purple for broadcast).
  Respects nothing from the user's toggles except master mute (HQ wants everything).
- Audio unlock: an overlay "Klik om geluid aan te zetten" until the first click (browser autoplay policy).

## Error handling

- Notifier errors are logged and the run is skipped; state is only saved after notifications are stored, so a
  crash re-detects instead of losing events (at worst a duplicate, never a miss). Article/area state updates use
  the values read at the start of the run.
- Push failures never block the notifier (fire-and-forget with logging); dead subscriptions are pruned.
- Feed polling errors are silent (SWR retries); `since` only advances on success.

## Testing

- Server (bun test): `notifier.helpers` (status diff incl. partial area list, unknown previous, new articles,
  deadline window edges 19:59/20:00/29:59/30:00, submitted/warned skip), `runNotifier` first-run silence and
  dedupe against an in-memory Mongo like the existing tests, `push.service` type filtering + 410 pruning
  (web-push mocked), routes validation for preferences and broadcast.
- Client (bun test): `lib/notifications` `shouldAlert`, `lib/push` `isIosNotInstalled`.
- Manual: demo mode end-to-end — toggle area status / new article / hunt report in demo, check toast + sound,
  push with app in background on Android and installed iOS PWA, `/hq` banner and audio unlock.

## Out of scope

Score/rank alerts (needs feature suggestion 1 first), per-device preferences, quiet hours, websockets.
