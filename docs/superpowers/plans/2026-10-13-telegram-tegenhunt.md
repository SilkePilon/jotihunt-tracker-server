# Telegram link + automatic tegenhunt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin links the group's Telegram account by QR; the server reads @Jotihunt_bot, auto-alerts on tegenhunts and serves the messages; the client shows an automatic Tegenhunt card and a new "Jotihunt-berichten" card.

**Architecture:** Server: `@mtcute/bun` behind a small `TelegramGateway` interface (mockable), encrypted session in the real (non-demo) DB, pure parser helpers, `/admin/telegram*`, `/telegram/messages`, `/counter-hunt`. Client: two sidebar sections built from SWR hooks, flat marker-style circles, `CookieBadge`.

**Tech Stack:** Bun, Express, Mongoose, express-validator, `@mtcute/bun`; React 19, SWR, Tailwind v4, shadcn/ui.

Spec: `docs/superpowers/specs/2026-10-13-telegram-tegenhunt-design.md` (client repo). Mockups: `jotihunt-tracker-client/.superpowers/brainstorm/3076851-1791876566/content/{telegram-card-v4,telegram-link-v2,counterhunt-auto}.html`.

## Global Constraints

- Server worktree `.worktrees/server-telegram` (branch `feat/telegram-listener`); client worktree `.worktrees/client-trackercard` (branch `feat/counterhunt-redesign`).
- Tests: `npx --yes bun test`; server typecheck `npx --yes bun x tsc --noEmit`; client `npx --yes bun run lint` + `npx --yes bun run build`. Mongo for server tests: docker `jotihunt-mongodb-1` on localhost:27017, DB `jotihunt-test` (see existing tests). Never restart the live docker stack.
- Dutch UI copy exactly as in the spec. No shadows on markers/badges. Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Telegram session ciphertext never logged or returned. Only messages from the bot username are handled or stored.

## API contract (both sides rely on this)

```ts
// GET /admin/telegram  (admin)    POST /admin/telegram/link → same shape   DELETE /admin/telegram/link → 204
// POST /admin/telegram/password { password } → same shape; 400 { message: "Wachtwoord klopt niet." } on a wrong password
type TelegramAdminStatus = {
  state: 'unavailable' | 'unlinked' | 'qr' | 'password' | 'linked';
  url?: string;          // tg://login?token=… while state === 'qr'
  expiresAt?: string;    // ISO, current QR token expiry
  hint?: string;         // 2FA password hint while state === 'password'
  account?: { name: string; username?: string; phoneMasked?: string };
  linkedAt?: string;
  lastMessageAt?: string;
};
// GET /telegram/messages?limit=50  (any user)
type BotMessageKind = 'tegenhunt' | 'hunt-approved' | 'hunt-rejected' | 'assignment' | 'happy-hour' | 'other';
type TelegramMessages = { linked: boolean; messages: { id: string; text: string; kind: BotMessageKind; receivedAt: string }[] };
// GET /counter-hunt  (any user)
type CounterHuntView =
  | { active: true; direction: number | null; startedAt: string; endsAt: string; text?: string }
  | { active: false; last?: { direction: number | null; startedAt: string } };
```

---

### Task S1 (server): pure helpers

**Files:** Create `src/services/telegram.helpers.ts` + `.test.ts`.
- `classifyBotMessage(text): BotMessageKind` — keyword rules from the spec (tegenhunt first).
- `parseCounterHuntDirection(text): CounterHuntDirection | null` — degrees ("45°", "45 graden", "45 deg") → nearest 45° (mod 360); else whole-word Dutch names longest-first and 16-point names (NNO→0/45 nearest, ONO, OZO, ZZO, ZZW, WZW, WNW, NNW) and abbreviations (N, NO, O, ZO, Z, ZW, W, NW) as whole words, case-insensitive. "Zoek", "Oosterbeek", "Westervoort" must NOT match.
- `encryptSession(plain, keyB64) → { ciphertext, iv, tag }` and `decryptSession(...)` with AES-256-GCM (node:crypto); key must decode to 32 bytes else throw.
- `maskPhone("+31612345612") → "+31 6 ••• 12"`.
- `counterHuntView(latest: { data, createdAt } | null, now): CounterHuntView` (30 min window; `startedAt` = `data.startedAt ?? createdAt`; `text` = `data.text` when direction null).
- [ ] TDD each; commit `feat(telegram): message parsing and session helpers`.

### Task S2 (server): models, gateway, service, routes, boot

**Files:** Create `src/models/telegram-link.model.ts`, `src/models/telegram-message.model.ts`, `src/services/telegram.gateway.ts` (mtcute implementation of `TelegramGateway`), `src/services/telegram.service.ts` + `.test.ts` (with a fake gateway), `src/controllers/telegram.controller.ts`, `src/routes/telegram.route.ts` (+ admin routes in `admin.route.ts` or a new router mounted under `/admin/telegram`), `GET /counter-hunt` route. Modify `src/index.ts` (start listener after DB connect), `src/app.ts` (mount routes), `.env.example` (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_KEY, TELEGRAM_BOT_USERNAME), `package.json` (`@mtcute/bun`).
- `TelegramGateway`: `startQr(handlers: { onUrl(url, expires), onScanned() }): Promise<'linked' | 'password'>`, `submitPassword(pw): Promise<void>` (throws `WrongPasswordError`), `me(): Promise<{ id; name; username?; phone? }>`, `exportSession(): Promise<string>`, `connect(session): Promise<void>`, `onMessage(cb: (msg: { id: number; senderUsername?: string; text: string; date: Date }) => void)`, `logout(): Promise<void>`, `cancel()`.
- The link doc and messages live in the **real** DB like the prediction setting (`getDemoStateStore()` / same connection), not the demo DB.
- On a bot message: upsert `TelegramMessage` by telegramId (skip if exists); if kind tegenhunt → create `AppNotification` (`buildCounterHuntNotification(direction, "Telegram")` with `data.telegramId/startedAt`, or the "Tegenhunt!" null-direction variant with `data.text`) and `sendToAll` exactly like `notificationsController.counterHunt`. Dedup by telegramId.
- Remove `POST /admin/counter-hunt` + `notificationsController.counterHunt` (+ its tests).
- Feature off (no API id/hash) ⇒ status `unavailable`, routes still answer.
- [ ] Service tests with fake gateway (link → qr → linked stores encrypted session; password path; wrong password; unlink; non-bot sender ignored; tegenhunt creates one notification; dedup). Route tests: admin-only for `/admin/telegram*`, user ok for `/telegram/messages` and `/counter-hunt`.
- [ ] tsc + tests green; commit `feat(telegram): link the group's Telegram account and auto-alert tegenhunts`.

### Task C1 (client): data hooks + helpers

**Files:** `src/types/Telegram.ts`, `src/hooks/telegram.hook.ts` (`useTelegramMessages`, `useTelegramAdmin` with link/password/unlink actions, poll 2 s while `qr`/`password`), `src/hooks/counter-hunt.hook.ts` (`useCounterHunt`, 10 s while active else 30 s; revalidate on an incoming `counter-hunt` notification if the notification feed hook exposes that), `src/lib/counter-hunt.ts` additions (`minutesLeft`, `counterHuntSummary`, direction name lookups, keep `COUNTER_HUNT_DIRECTIONS`), `src/lib/bot-messages.ts` (`BOT_MESSAGE_STYLE: Record<BotMessageKind, { label; glyph; container; on }>` using marker palette keys) + tests.
- [ ] TDD helpers; commit.

### Task C2 (client): Tegenhunt card + map sector

**Files:** rewrite `src/components/cards/counter-hunt/CounterHuntCard.tsx` (states 1, 1b, 2, 2b, 4), delete `CounterHuntAlertButton.tsx`, `src/stores/counterhunt.store.ts` and their uses (`HomeCircle`, `LayersSubmenu` if it toggles visibility — keep a layer toggle if one exists, reading the server state), `SidebarSections.tsx` (summary + forced open when it becomes active, like `TrackerSection`), `CookieBadge` gains tones `danger` (#dc2626) / `neutral` (muted) and an optional `glyph` (text or ReactNode) replacing the check. Tour step body: "Wordt ons clubhuis gehunt? Dan zie je hier automatisch uit welke richting, en op de kaart." 
- [ ] lint/build/test; commit.

### Task C3 (client): Jotihunt-berichten card + admin linking

**Files:** `src/components/cards/telegram/TelegramCard.tsx`, `BotMessageTimeline.tsx`, `BotMessageMarker.tsx`, `TelegramLinkPanel.tsx`, `TelegramLogo.tsx`; glyph paths (Material Symbols Rounded filled: check, close, assignment_turned_in, celebration, chat, e911_emergency) added to `src/components/layers/marker-glyphs.ts`; `sidebar.store.ts` new section id `telegram` default closed; `SidebarSections.tsx` adds it after Tegenhunt; tour target if sections need one.
- [ ] lint/build/test; commit.

### Task V (verify)

- [ ] Server: run locally on another PORT against a throwaway DB with real TELEGRAM_API_ID/HASH if available; otherwise unit tests only.
- [ ] Client: preview harness with mocked data for all card states (light + dark), then delete the harness.
