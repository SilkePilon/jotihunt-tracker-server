# Telegram link, automatic tegenhunt and "Jotihunt-berichten" — Design

Date: 2026-10-13
Status: approved in brainstorm (visual companion mockups `.superpowers/brainstorm/3076851-1791876566/content/`:
`telegram-card-v4.html` (M2 + tegenhunt style B), `telegram-link-v2.html` (L1), `counterhunt-auto.html`)
Repos: `jotihunt-tracker-server` (Telegram listener, parser, API), `jotihunt-tracker-client` (two sidebar cards)

## Goal

The organisation announces a tegenhunt with a Telegram message from **@Jotihunt_bot** to the group's registered
account (rules §6: start time, wind direction, short explanation; the group then has 30 minutes). Today an admin has
to read it and press "Waarschuw iedereen" with the right direction. New: an admin links that Telegram account once by
scanning a QR code; the server then reads @Jotihunt_bot messages itself, alerts everyone automatically on a tegenhunt
and shows every bot message in a new sidebar card.

Prior art: ScoutingScherpenzeel/jotihunt-telegram-forwarder (Telethon user session, forwards @Jotihunt_bot to
Discord) and thehairyvikingniels/Joti (Telethon listener + keyword parser for tegenhunt/hunt/opdracht/happy hour).
Neither has a real tegenhunt message sample; our parser is keyword based and tolerant.

## Server

### Telegram client (mtcute)

- Library `@mtcute/bun` (maintained TypeScript MTProto client; GramJS is archived). User account, not a bot: bots
  cannot read another bot's DMs and cannot use QR login.
- Env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from my.telegram.org, once), `TELEGRAM_SESSION_KEY` (32-byte
  base64, AES-256-GCM key for the stored session), optional `TELEGRAM_BOT_USERNAME` (default `Jotihunt_bot`).
  Missing API id/hash ⇒ feature off (`status: "unavailable"`), everything else keeps working.
- Session: the mtcute session string is stored **encrypted** in Mongo (`TelegramLink` singleton document:
  `sessionCiphertext`, `iv`, `tag`, `account: { id, name, username?, phoneMasked }`, `linkedAt`, `linkedBy`).
  Never logged, never returned by the API.
- One listener per server process; the k8s server runs 1 replica (documented assumption).
- On boot: if a link exists, decrypt, connect, start listening. Connection errors are retried with backoff; an
  `AUTH_KEY_UNREGISTERED` / revoked session clears the link (status becomes `unlinked`) and logs a warning.
- Only messages whose sender is the bot username are handled; everything else is ignored and never stored.

### Linking flow (admins)

`telegram.service.ts` keeps at most one pending login.

- `POST /admin/telegram/link` → starts `signInQr`; responds `{ state: "qr", url: "tg://login?token=…", expiresAt }`.
  The token rotates (~30 s); the latest one is kept in memory.
- `GET /admin/telegram` → `{ state: "unavailable" | "unlinked" | "qr" | "password" | "linked", url?, expiresAt?,
  hint? (2FA hint), account?: { name, username?, phoneMasked }, linkedAt?, lastMessageAt? }`. Client polls it every
  2 s while linking.
- `POST /admin/telegram/password { password }` → supplies the 2FA cloud password when state is `password`; wrong
  password ⇒ 400 "Wachtwoord klopt niet" and state stays `password`.
- `DELETE /admin/telegram/link` → cancels a pending login or logs the session out (`auth.logOut`) and deletes the
  stored link.
- All routes `verifyToken, isAdmin`.

### Messages

- Model `TelegramMessage`: `telegramId` (unique), `text`, `kind`, `receivedAt`, `data` (e.g. `{ direction }`).
  No TTL during the event (a few hundred at most).
- `kind` from keywords (case-insensitive, pure function `classifyBotMessage(text)`):
  `tegenhunt` (contains "tegenhunt"), `hunt-approved` ("goedgekeurd"), `hunt-rejected` ("afgekeurd"),
  `assignment` ("opdracht" or "inzending"), `happy-hour` ("happy hour"), otherwise `other`.
- Only tegenhunt messages send a push; other kinds only appear in the card (no sound, no push).
- `GET /telegram/messages?limit=50` (any logged-in user) → newest first, `{ id, text, kind, receivedAt }`.
  Also `linked: boolean` so the card can show its empty states.

### Automatic tegenhunt

On a `tegenhunt` message:

1. `parseCounterHuntDirection(text)`: degrees ("45°", "45 graden") → nearest of the 8 directions; else Dutch names
   longest-first (noordoost, noordwest, zuidoost, zuidwest, noord, oost, zuid, west) and abbreviations as whole words
   (NO, NW, ZO, ZW, N, O, Z, W); 16-point names (NNO, …) round to the nearest 8-point direction. `null` when none.
2. Notification (existing `sendToAll`, push + sound, type `counter-hunt`, urgent):
   - with direction: the existing `buildCounterHuntNotification(direction, "Telegram")`;
   - without: title "Tegenhunt!", body "Richting niet herkend, lees het bericht van de Jotihunt-bot.",
     `data: { direction: null }`.
   `data` also gets `telegramId` and `startedAt` (message date).
3. Dedup: one notification per Telegram message id.

`GET /counter-hunt` (any logged-in user): the latest `counter-hunt` notification →
`{ active: boolean, direction: number | null, startedAt, endsAt (startedAt + 30 min), text? (bot text when direction
is null) } | { active: false, last?: { direction, startedAt } }`. Notifications live 48 h, enough for "Laatste".

The admin route `POST /admin/counter-hunt` and its client button are removed (manual alert no longer wanted).

## Client

### "Tegenhunt" card (replaces CounterHuntCard + CounterHuntAlertButton)

Data: `useCounterHunt()` SWR on `/counter-hunt` (30 s; 10 s while active) plus revalidate when a `counter-hunt`
notification arrives. The map sector (`HomeCircle`) reads the same hook instead of the local zustand store; the
store and the direction select/Toon/prullenbak/waarschuw UI are deleted.

States (mockup `counterhunt-auto.html`):

1. Quiet: grey cookie (48 px) with home glyph, "Geen tegenhunt", "Komt er een, dan zie je hem hier en op de kaart,
   en krijgt iedereen een melding." Collapsed summary "Geen".
   1b. Telegram not linked (`/telegram/messages` → `linked: false`): amber cookie with "!", "Tegenhunts komen niet
   binnen", "Telegram is niet gekoppeld. Koppelen kan in de kaart Jotihunt-berichten (admins)." Summary
   "Niet gekoppeld" (amber).
2. Active: red tinted card (`redsec` look), red cookie 64 px with the direction arrow, "Tegenhunt uit het
   noordoosten", "Gestart 21:14 · nog 24 min" (minutes tick), "Zoek de sticker binnen 500 m · toon op kaart"
   ("toon op kaart" = flyTo the sector centre like today). 2b. Direction null: cookie with "?", "Tegenhunt!",
   "Richting niet herkend; lees het bericht:" and the bot text in a quote box.
3. Collapsed active summary: "NO ↗ · nog 24 min" in red (or "nog 24 min").
4. Ended: quiet state with "Laatste: 21:14 uit het noordoosten".

The section is forced open when a tegenhunt becomes active (same pattern as TrackerSection), not collapsed when it
ends. Cookie badges reuse `CookieBadge` (extended with tone `danger`, `neutral` and a custom glyph).

### "Jotihunt-berichten" card (new, collapsed by default)

Sidebar section id `telegram`, title "Jotihunt-berichten", placed after "Tegenhunt". Default closed in the sidebar
store.

- Timeline M2: one row per message, newest first: marker circle (32 px) + bold label + time (HH:mm) right +
  text (muted, full text, wraps). Vertical line between markers with ~6 px gap above and below (not under them).
- Markers like the map markers but **flat (no shadow)**: container colour with the on-colour Material Symbols glyph
  and a 2 px rim in `surfaceContainerLowest`, from `MARKER_PALETTES[theme]`:
  hunt-approved `okContainer`/`check`; hunt-rejected `errorContainer`/`close`; assignment
  `tertiaryContainer`/`assignment_turned_in`; happy-hour `warnContainer`/`celebration`; other
  `surfaceContainerHighest`/`chat`. Labels: "Hunt goedgekeurd", "Hunt afgekeurd", "Opdracht", "Happy hour",
  "Bericht".
- Tegenhunt (style B): 36 px red **cookie** (`BADGE_COOKIE_DEPTH`) with rim, solid `#dc2626`, white
  `e911_emergency` glyph; label "Tegenhunt".
- Glyphs as SVG paths in `marker-glyphs.ts` (Material Symbols Rounded, filled), no icon font.
- Collapsed summary: "HH:mm · {label}" of the newest message; nothing when empty.
- Empty: "Nog geen berichten van @Jotihunt_bot".

Admin linking (L1), inside this card, admins only:

- Not linked: muted sentence "Koppel het Telegram-account dat de berichten van @Jotihunt_bot krijgt. Tegenhunts
  worden dan automatisch gemeld." + large Telegram-blue (`#229ED9`) button with the **Telegram logo** and
  "Koppel Telegram". Non-admins see the empty text only.
- QR (P3 style, same as Mijn tracker pairing): header "Scan in Telegram" + ✕; 96 px QR of the `tg://login` URL
  left; right "Instellingen → Apparaten → **Desktop-apparaat koppelen**" and spinner + seconds until the token
  rotates. Below, small warning: "De server kan alle chats van dit account lezen, maar gebruikt alleen berichten van
  @Jotihunt_bot."
- Password (2FA): "Cloud-wachtwoord van Telegram" input (+ hint as placeholder) + "Koppelen" button; error text
  under the input.
- Linked: under the timeline a divider and one muted line "Luistert via **Silke**" (no dot) with "ontkoppelen"
  link on the right (confirm with the existing `ConfirmDialog`).
- `unavailable` (no API id/hash on the server): admins see "Telegram is niet ingesteld op de server
  (TELEGRAM_API_ID/HASH)."

## Out of scope

Parsing hunt codes/points into other app data, forwarding to Discord, Android app UI (it already gets the
`counter-hunt` push with sound).

## Testing

- Server unit: `classifyBotMessage`, `parseCounterHuntDirection` (degrees, names, abbreviations, 16-point, none,
  words like "Zoek" must not match "Z"), session encrypt/decrypt round trip, `/counter-hunt` view (active, ended,
  null direction), dedup per message id, route auth (admin vs user).
- Telegram client mocked behind a small interface (`TelegramGateway`: `startQr`, `submitPassword`, `logout`,
  `onBotMessage`), so the service is tested without network.
- Client unit: counter-hunt view helpers (minutes left, summary text), message kind → marker style.
- Manual: link a real account via QR on the local stack, send a test message from the account to itself is NOT
  enough (sender must be the bot) → use a test bot username via `TELEGRAM_BOT_USERNAME` pointing at a bot we
  control, send "Er is een tegenhunt gestart, windrichting noordoost" and check push, sector, card states.
