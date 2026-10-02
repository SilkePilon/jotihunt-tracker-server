# Notifications (push + sounds) and HQ wall display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side event feed that turns fox status changes, new articles, nearing hunt deadlines and admin broadcasts into notifications, delivered as Web Push and as in-app sound + toast, plus an admin-only `/hq` wall display.

**Architecture:** A 10 s notifier cron diffs Mongo state (areas, articles, hunt reports) against a stored `NotifierState`, inserts `Notification` documents and pushes them with `web-push`. Clients poll `GET /notifications?since=` and play per-type sounds; a service worker shows system notifications when no app window is focused. `/hq` is a fullscreen page reusing existing hooks and the map.

**Tech Stack:** Server: Bun, Express 5, Mongoose 9, express-validator, node-cron, `web-push`. Client: React 19, Vite 8, SWR, zustand, sonner, shadcn/Radix, vite-plugin-pwa (generateSW + `importScripts`).

Spec: `docs/superpowers/specs/2026-10-03-notifications-hq-design.md`.

## Global Constraints

- Repos/branches: server `jotihunt-tracker-server` branch `feat/notifications`; client worktree `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client-notifications` branch `feat/notifications`. Never touch `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client` (has the user's uncommitted work).
- `bun` is not on PATH: use `npx --yes bun ...`. Server tests need Mongo on localhost:27017 (docker `jotihunt-mongodb-1`), DB `jotihunt-test`. Never restart the docker stack. Don't `pkill -f`.
- Server checks: `npx --yes bun test <file>`, `npx --yes bun x tsc --noEmit`, `npx --yes bun x eslint <files>`. Client checks: `npx --yes bun test <file>`, `npx --yes bun x tsc -b`, `npx --yes bun x eslint <files>`.
- Services must not import `logger` from `..` (that boots the server); inject a logger or use `console` like existing services.
- UI text and error messages in Dutch. Code comments in English, same density as surrounding code.
- Notification types: `fox-status` | `hint` | `article` | `hunt-deadline` | `broadcast`. `broadcast` cannot be disabled.
- Deadline warning: once, when `now - (huntTime ?? createdAt) >= 20 min` and `< 30 min`, report not submitted, not warned before.
- Notification TTL 48 h. Feed max 50 per request.
- Commit messages: conventional (`feat(...)`, `fix(...)`), ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

## Server

### Task S1: Notifier helpers + models

**Files:**
- Create: `src/services/notifier.helpers.ts`
- Create: `src/services/notifier.helpers.test.ts`
- Create: `src/models/notification.model.ts`
- Create: `src/models/notifier-state.model.ts`
- Create: `src/models/push-subscription.model.ts`
- Modify: `src/models/user.model.ts` (add `notificationPrefs`)
- Modify: `src/models/hunt-report.model.ts` (add `deadlineWarnedAt`)

**Interfaces:**
- Produces: `NOTIFICATION_TYPES`, `OPTIONAL_NOTIFICATION_TYPES`, `type NotificationType`, `isTypeEnabled(type, disabledTypes)`, `diffAreaStatus`, `newArticles`, `dueDeadlineWarnings`, `buildFoxStatusNotification`, `buildArticleNotification`, `buildDeadlineNotification`, `buildBroadcastNotification`, `interface NotificationInput`, `DEADLINE_WARNING_AFTER_MS`, `HUNT_SUBMIT_WINDOW_MS`; models `AppNotification` (+ `AppNotificationDocument`, `toNotificationView`), `NotifierState`, `PushSubscription`.

- [ ] **Step 1: Write failing tests** — `src/services/notifier.helpers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildArticleNotification,
  buildBroadcastNotification,
  buildDeadlineNotification,
  buildFoxStatusNotification,
  diffAreaStatus,
  dueDeadlineWarnings,
  isTypeEnabled,
  newArticles,
} from "./notifier.helpers";

const MIN = 60 * 1000;
const now = new Date("2026-10-17T20:00:00Z");

describe("diffAreaStatus", () => {
  test("reports changed areas", () => {
    expect(diffAreaStatus({ Alpha: "red", Bravo: "red" }, [{ name: "Alpha", status: "green" }, { name: "Bravo", status: "red" }])).toEqual([
      { area: "Alpha", from: "red", to: "green" },
    ]);
  });
  test("ignores areas without a previous status and areas missing from the current read", () => {
    expect(diffAreaStatus({ Alpha: "red" }, [{ name: "Charlie", status: "green" }])).toEqual([]);
  });
});

describe("newArticles", () => {
  test("returns articles above the last id, sorted", () => {
    expect(newArticles([{ id: 5 }, { id: 3 }, { id: 7 }], 4).map((article) => article.id)).toEqual([5, 7]);
  });
});

describe("dueDeadlineWarnings", () => {
  const report = (minutesAgo: number, extra: object = {}) => ({ huntTime: new Date(now.getTime() - minutesAgo * MIN), createdAt: new Date(now.getTime() - minutesAgo * MIN), ...extra });
  test("window is 20 (inclusive) to 30 (exclusive) minutes", () => {
    expect(dueDeadlineWarnings([report(19.99)], now)).toHaveLength(0);
    expect(dueDeadlineWarnings([report(20)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(29.99)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(30)], now)).toHaveLength(0);
  });
  test("skips submitted and already warned reports", () => {
    expect(dueDeadlineWarnings([report(25, { submittedAt: now }), report(25, { deadlineWarnedAt: now })], now)).toHaveLength(0);
  });
  test("uses createdAt when the hunt time is unknown", () => {
    expect(dueDeadlineWarnings([{ huntTime: null, createdAt: new Date(now.getTime() - 22 * MIN) }], now)).toHaveLength(1);
  });
});

describe("builders", () => {
  test("to green is urgent", () => {
    const notification = buildFoxStatusNotification({ area: "alpha", from: "orange", to: "green" });
    expect(notification).toMatchObject({ type: "fox-status", urgent: true, title: "GROEN: Alpha — jagen mag!", data: { area: "alpha", status: "green", previousStatus: "orange" } });
  });
  test("other changes are not urgent", () => {
    expect(buildFoxStatusNotification({ area: "Bravo", from: "green", to: "red" })).toMatchObject({ urgent: false, title: "Bravo is nu rood", body: "Was groen." });
  });
  test("article types", () => {
    expect(buildArticleNotification({ id: 1, title: "Hint 3", type: "hint" })).toMatchObject({ type: "hint", title: "Nieuwe hint", body: "Hint 3" });
    expect(buildArticleNotification({ id: 2, title: "Foto", type: "assignment", endTime: new Date("2026-10-17T21:30:00Z") })).toMatchObject({
      type: "article",
      title: "Nieuwe opdracht",
      body: "Foto (deadline 23:30)",
    });
    expect(buildArticleNotification({ id: 3, title: "Info", type: "news" })).toMatchObject({ type: "article", title: "Nieuw bericht" });
  });
  test("deadline", () => {
    const notification = buildDeadlineNotification(
      { _id: "r1", area: "bravo", huntTime: new Date(now.getTime() - 20 * MIN), createdAt: now, reportedByName: "Sam" },
      now,
    );
    expect(notification).toMatchObject({ type: "hunt-deadline", title: "Hunt Bravo moet over 10 min ingestuurd zijn", data: { area: "bravo", huntReportId: "r1" } });
  });
  test("broadcast", () => {
    expect(buildBroadcastNotification("Terug naar HQ", "Kim")).toMatchObject({ type: "broadcast", urgent: true, title: "Bericht van HQ", body: "Terug naar HQ", data: { from: "Kim" } });
  });
});

test("isTypeEnabled: broadcast always on", () => {
  expect(isTypeEnabled("broadcast", ["broadcast"])).toBe(true);
  expect(isTypeEnabled("hint", ["hint"])).toBe(false);
  expect(isTypeEnabled("hint", [])).toBe(true);
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/services/notifier.helpers.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `src/services/notifier.helpers.ts`:

```ts
export const NOTIFICATION_TYPES = ["fox-status", "hint", "article", "hunt-deadline", "broadcast"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** Types a user can switch off; broadcasts from HQ always come through. */
export const OPTIONAL_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter((type) => type !== "broadcast");

/** A registered hunt must be submitted within 30 minutes; warn when 10 minutes are left. */
export const HUNT_SUBMIT_WINDOW_MS = 30 * 60 * 1000;
export const DEADLINE_WARNING_AFTER_MS = 20 * 60 * 1000;

export interface NotificationInput {
  type: NotificationType;
  /** Dutch, ready to show */
  title: string;
  body: string;
  urgent: boolean;
  data: Record<string, unknown>;
}

export interface AreaStatusChange {
  area: string;
  from: string;
  to: string;
}

const STATUS_NL: Record<string, string> = { green: "groen", orange: "oranje", red: "rood" };
const statusNl = (status: string) => STATUS_NL[status] ?? status;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

export function isTypeEnabled(type: string, disabledTypes: readonly string[]): boolean {
  return type === "broadcast" || !disabledTypes.includes(type);
}

/**
 * Areas whose status changed since the previous run. Areas without a previous status are new (no event), and
 * areas missing from `current` are ignored: the areas cron rewrites the collection, so a read can be partial.
 */
export function diffAreaStatus(previous: Record<string, string>, current: { name: string; status: string }[]): AreaStatusChange[] {
  return current
    .filter((area) => previous[area.name] !== undefined && previous[area.name] !== area.status)
    .map((area) => ({ area: area.name, from: previous[area.name], to: area.status }));
}

export function newArticles<T extends { id: number }>(articles: T[], lastArticleId: number): T[] {
  return articles.filter((article) => article.id > lastArticleId).sort((a, b) => a.id - b.id);
}

interface DeadlineReport {
  huntTime?: Date | null;
  createdAt: Date;
  submittedAt?: Date | null;
  deadlineWarnedAt?: Date | null;
}

/** Reports that reached 10 minutes before their submit deadline and were neither submitted nor warned about. */
export function dueDeadlineWarnings<T extends DeadlineReport>(reports: T[], now: Date): T[] {
  return reports.filter((report) => {
    if (report.submittedAt || report.deadlineWarnedAt) return false;
    const age = now.getTime() - (report.huntTime ?? report.createdAt).getTime();
    return age >= DEADLINE_WARNING_AFTER_MS && age < HUNT_SUBMIT_WINDOW_MS;
  });
}

export function buildFoxStatusNotification(change: AreaStatusChange): NotificationInput {
  const area = capitalize(change.area);
  const data = { area: change.area, status: change.to, previousStatus: change.from };
  if (change.to === "green") {
    return { type: "fox-status", title: `GROEN: ${area} — jagen mag!`, body: `Was ${statusNl(change.from)}.`, urgent: true, data };
  }
  return { type: "fox-status", title: `${area} is nu ${statusNl(change.to)}`, body: `Was ${statusNl(change.from)}.`, urgent: false, data };
}

export function buildArticleNotification(article: { id: number; title: string; type: string; endTime?: Date | null }): NotificationInput {
  const data = { articleId: article.id };
  if (article.type === "hint") return { type: "hint", title: "Nieuwe hint", body: article.title, urgent: false, data };
  if (article.type === "assignment") {
    const deadline = article.endTime ? ` (deadline ${clock(article.endTime)})` : "";
    return { type: "article", title: "Nieuwe opdracht", body: `${article.title}${deadline}`, urgent: false, data };
  }
  return { type: "article", title: "Nieuw bericht", body: article.title, urgent: false, data };
}

export function buildDeadlineNotification(
  report: { _id: unknown; area: string; huntTime?: Date | null; createdAt: Date; reportedByName: string },
  now: Date,
): NotificationInput {
  const deadline = (report.huntTime ?? report.createdAt).getTime() + HUNT_SUBMIT_WINDOW_MS;
  const minutes = Math.max(1, Math.ceil((deadline - now.getTime()) / 60000));
  return {
    type: "hunt-deadline",
    title: `Hunt ${capitalize(report.area)} moet over ${minutes} min ingestuurd zijn`,
    body: `Geregistreerd door ${report.reportedByName}, nog niet ingestuurd.`,
    urgent: false,
    data: { area: report.area, huntReportId: String(report._id) },
  };
}

export function buildBroadcastNotification(message: string, from: string): NotificationInput {
  return { type: "broadcast", title: "Bericht van HQ", body: message, urgent: true, data: { from } };
}
```

- [ ] **Step 4: Models.** `src/models/notification.model.ts`:

```ts
import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { NOTIFICATION_TYPES } from "../services/notifier.helpers";

/** Something users are alerted about (push + in-app sound). Kept 48 hours; the feed only serves recent ones. */
const NotificationSchema = new mongoose.Schema({
  type: { type: String, enum: NOTIFICATION_TYPES, required: true },
  title: { type: String, required: true },
  body: { type: String, required: false, default: "" },
  data: { type: mongoose.Schema.Types.Mixed, required: false, default: {} },
  urgent: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

// Named AppNotification: `Notification` is also the browser/Bun global
export const AppNotification = mongoose.model("Notification", NotificationSchema);
export type AppNotificationDocument = HydratedDocument<InferSchemaType<typeof NotificationSchema>>;

export function toNotificationView(notification: AppNotificationDocument | (InferSchemaType<typeof NotificationSchema> & { _id: unknown })) {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body ?? "",
    urgent: notification.urgent,
    data: notification.data ?? {},
    createdAt: notification.createdAt,
  };
}
export type NotificationView = ReturnType<typeof toNotificationView>;
```

`src/models/notifier-state.model.ts`:

```ts
import mongoose from "mongoose";

/** What the notifier saw last (one document per database), so it only alerts about changes. */
const NotifierStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "notifier" },
  areaStatus: { type: Map, of: String, required: true, default: () => new Map() },
  lastArticleId: { type: Number, required: true, default: 0 },
  /** False until the first run stored the current state (that run sends nothing) */
  initialized: { type: Boolean, required: true, default: false },
});

export const NotifierState = mongoose.model("NotifierState", NotifierStateSchema);
```

`src/models/push-subscription.model.ts`:

```ts
import mongoose from "mongoose";

/** A browser push endpoint of a user (one per device/browser). Removed when the push service reports it gone. */
const PushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const PushSubscription = mongoose.model("PushSubscription", PushSubscriptionSchema);
```

In `src/models/user.model.ts`, add after `tutorialVersion` (before `tracker`):

```ts
  /** Opt-out notification settings, shared by all of the user's devices (push) and in-app sounds */
  notificationPrefs: {
    disabledTypes: { type: [String], required: true, default: [] },
    /** Highest "Meldingen" dialog version shown (client NOTIFICATIONS_PROMPT_VERSION); 0 = never */
    promptedVersion: { type: Number, required: true, default: 0 },
  },
```

In `src/models/hunt-report.model.ts`, add after `submittedByName`:

```ts
    /** When the "10 minutes left" notification was created (at most once per report) */
    deadlineWarnedAt: { type: Date, required: false, default: null },
```

- [ ] **Step 5: Run** `npx --yes bun test src/services/notifier.helpers.test.ts src/models/user.model.test.ts` — expect PASS. Then `npx --yes bun x tsc --noEmit` — expect no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/notifier.helpers.ts src/services/notifier.helpers.test.ts src/models/notification.model.ts src/models/notifier-state.model.ts src/models/push-subscription.model.ts src/models/user.model.ts src/models/hunt-report.model.ts
git commit -m "feat(notifications): notification models and event diff helpers"
```

---

### Task S2: Push service (web-push)

**Files:**
- Modify: `package.json` (dependency `web-push`, devDependency `@types/web-push`)
- Create: `src/services/push.service.ts`
- Create: `src/services/push.service.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `PushSubscription`, `User.notificationPrefs`, `isTypeEnabled` (S1).
- Produces: `vapidPublicKey(): string | null`, `isPushConfigured(): boolean`, `sendToAll(notification: PushNotificationInput, log?: PushLogger): Promise<{ sent: number; removed: number }>`, `setPushSender(sender: PushSender | null)`, `resetPushConfig()`.

- [ ] **Step 1: Install** `npx --yes bun add web-push && npx --yes bun add -d @types/web-push`.

- [ ] **Step 2: Write failing test** `src/services/push.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import webpush from "web-push";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { resetPushConfig, sendToAll, setPushSender } from "./push.service";

const silent = { error() {}, warn() {} };
const calls: string[] = [];

beforeAll(async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:test@test.nl";
  await connectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  calls.length = 0;
  resetPushConfig();
  setPushSender({
    async sendNotification(subscription) {
      calls.push(subscription.endpoint);
      if (subscription.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return {};
    },
  });
});
afterAll(async () => {
  setPushSender(null);
  await disconnectTestDb();
});

async function subscribe(name: string, endpoint: string, disabledTypes: string[] = []) {
  const user = await User.create({ email: `${name}@t.nl`, password: "x", name, notificationPrefs: { disabledTypes, promptedVersion: 0 } });
  await PushSubscription.create({ user: user._id, endpoint, keys: { p256dh: "p", auth: "a" } });
}

const notification = (type: "hint" | "broadcast") => ({ _id: "n1", type, title: "T", body: "B", urgent: false, data: {} });

describe("sendToAll", () => {
  test("skips users who disabled the type", async () => {
    await subscribe("a", "https://push/a");
    await subscribe("b", "https://push/b", ["hint"]);
    const result = await sendToAll(notification("hint"), silent);
    expect(calls).toEqual(["https://push/a"]);
    expect(result.sent).toBe(1);
  });
  test("broadcast reaches everyone", async () => {
    await subscribe("b", "https://push/b", ["hint", "broadcast"]);
    await sendToAll(notification("broadcast"), silent);
    expect(calls).toEqual(["https://push/b"]);
  });
  test("removes subscriptions the push service reports gone", async () => {
    await subscribe("a", "https://push/gone");
    const result = await sendToAll(notification("hint"), silent);
    expect(result.removed).toBe(1);
    expect(await PushSubscription.countDocuments()).toBe(0);
  });
  test("does nothing without VAPID keys", async () => {
    await subscribe("a", "https://push/a");
    const saved = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    resetPushConfig();
    expect(await sendToAll(notification("hint"), silent)).toEqual({ sent: 0, removed: 0 });
    process.env.VAPID_PRIVATE_KEY = saved;
  });
});
```

- [ ] **Step 3: Run** `npx --yes bun test src/services/push.service.test.ts` — expect FAIL.

- [ ] **Step 4: Implement** `src/services/push.service.ts`:

```ts
import webpush from "web-push";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { isTypeEnabled } from "./notifier.helpers";

export interface PushNotificationInput {
  _id: unknown;
  type: string;
  title: string;
  body?: string | null;
  urgent: boolean;
  data?: unknown;
}

export interface PushLogger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

/** The part of web-push used here; replaced in tests. */
export interface PushSender {
  sendNotification(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options?: webpush.RequestOptions): Promise<unknown>;
}

const PARALLEL_SENDS = 10;
/** Alerts older than this are useless (a fox status from an hour ago); the push service drops them. */
const PUSH_TTL_SECONDS = 15 * 60;

let configured: boolean | null = null;
let sender: PushSender = webpush;

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

/** True when the VAPID keys are set (checked once, then cached). */
export function isPushConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = vapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return (configured = false);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:jotihunt@example.com", publicKey, privateKey);
  return (configured = true);
}

/** Tests only */
export function setPushSender(next: PushSender | null) {
  sender = next ?? webpush;
}

/** Tests only */
export function resetPushConfig() {
  configured = null;
}

/** Push a notification to every subscribed device whose user has its type switched on. Never throws. */
export async function sendToAll(notification: PushNotificationInput, log: PushLogger = console): Promise<{ sent: number; removed: number }> {
  const result = { sent: 0, removed: 0 };
  if (!isPushConfigured()) return result;

  try {
    const subscriptions = await PushSubscription.find().lean();
    const userIds = [...new Set(subscriptions.map((subscription) => subscription.user.toString()))];
    const users = await User.find({ _id: { $in: userIds } }, { notificationPrefs: 1 }).lean();
    const disabledByUser = new Map(users.map((user) => [user._id.toString(), user.notificationPrefs?.disabledTypes ?? []]));
    const targets = subscriptions.filter((subscription) => {
      const disabled = disabledByUser.get(subscription.user.toString());
      return disabled !== undefined && isTypeEnabled(notification.type, disabled);
    });

    const payload = JSON.stringify({
      id: String(notification._id),
      type: notification.type,
      title: notification.title,
      body: notification.body ?? "",
      urgent: notification.urgent,
      url: "/",
    });
    const options: webpush.RequestOptions = { TTL: PUSH_TTL_SECONDS, urgency: notification.urgent ? "high" : "normal" };

    for (let index = 0; index < targets.length; index += PARALLEL_SENDS) {
      await Promise.all(
        targets.slice(index, index + PARALLEL_SENDS).map(async (subscription) => {
          try {
            await sender.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, options);
            result.sent++;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await PushSubscription.deleteOne({ endpoint: subscription.endpoint });
              result.removed++;
            } else {
              log.error(`Push to ${new URL(subscription.endpoint).host} failed`, error);
            }
          }
        }),
      );
    }
  } catch (error) {
    log.error("Sending push notifications failed", error);
  }
  return result;
}
```

- [ ] **Step 5: `.env.example`** — append:

```
# Web Push (pushmeldingen). Generate once with: npx web-push generate-vapid-keys
# Optional: without keys there are no push notifications; in-app sounds and toasts still work.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:
```

- [ ] **Step 6: Run** `npx --yes bun test src/services/push.service.test.ts` — PASS; `npx --yes bun x tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/services/push.service.ts src/services/push.service.test.ts .env.example
git commit -m "feat(notifications): web push service with per-type opt-out"
```

---

### Task S3: Notifier service + cron

**Files:**
- Create: `src/services/notifier.service.ts`
- Create: `src/services/notifier.service.test.ts`
- Create: `src/crons/notifier.cron.ts`
- Modify: `src/index.ts` (schedule cron, VAPID warning)

**Interfaces:**
- Consumes: S1 helpers/models, `sendToAll` (S2), `Area`, `Article`, `HuntReport`.
- Produces: `runNotifier(options?: { now?: Date; send?: (notification: AppNotificationDocument) => Promise<unknown>; log?: { error(message: string, error?: unknown): void } }): Promise<AppNotificationDocument[]>`.

- [ ] **Step 1: Write failing test** `src/services/notifier.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Area } from "../models/area.model";
import { Article } from "../models/article.model";
import { HuntReport } from "../models/hunt-report.model";
import { AppNotification } from "../models/notification.model";
import { NotifierState } from "../models/notifier-state.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { runNotifier } from "./notifier.service";

const MIN = 60 * 1000;
const now = new Date("2026-10-17T20:00:00Z");
const sent: string[] = [];
const run = (at = now) => runNotifier({ now: at, send: async (notification) => void sent.push(notification.title) });

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
});
afterAll(disconnectTestDb);

async function setAreas(statuses: Record<string, string>) {
  await Area.deleteMany({});
  await Area.insertMany(Object.entries(statuses).map(([name, status]) => ({ name, status, updatedAt: now })));
}

describe("runNotifier", () => {
  test("first run only records state", async () => {
    await setAreas({ Alpha: "red" });
    await Article.create({ id: 1, title: "Hint 1", type: "hint", publishAt: now, content: "x" });
    expect(await run()).toHaveLength(0);
    const state = await NotifierState.findOne();
    expect(state?.initialized).toBe(true);
    expect(state?.lastArticleId).toBe(1);
  });

  test("status change, new article, sent once", async () => {
    await setAreas({ Alpha: "red", Bravo: "red" });
    await run();
    await setAreas({ Alpha: "green", Bravo: "red" });
    await Article.create({ id: 2, title: "Nieuws", type: "news", publishAt: now, content: "x" });
    const created = await run();
    expect(created.map((notification) => notification.title)).toEqual(["GROEN: Alpha — jagen mag!", "Nieuw bericht"]);
    expect(sent).toHaveLength(2);
    expect(await run()).toHaveLength(0);
    expect(await AppNotification.countDocuments()).toBe(2);
  });

  test("a partial area read does not forget statuses", async () => {
    await setAreas({ Alpha: "red", Bravo: "red" });
    await run();
    await setAreas({ Alpha: "red" });
    await run();
    await setAreas({ Alpha: "red", Bravo: "green" });
    expect((await run()).map((notification) => notification.data.area)).toEqual(["Bravo"]);
  });

  test("deadline warning once", async () => {
    await run();
    const user = await User.create({ email: "s@t.nl", password: "x", name: "Sam" });
    await HuntReport.create({ area: "bravo", photo: "p.jpg", reportedBy: user._id, reportedByName: "Sam", huntTime: new Date(now.getTime() - 21 * MIN) });
    await HuntReport.create({ area: "alpha", photo: "q.jpg", reportedBy: user._id, reportedByName: "Sam", huntTime: new Date(now.getTime() - 21 * MIN), submittedAt: now });
    const created = await run();
    expect(created.map((notification) => notification.type)).toEqual(["hunt-deadline"]);
    expect(await run()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/services/notifier.service.test.ts` — FAIL.

- [ ] **Step 3: Implement** `src/services/notifier.service.ts`:

```ts
import { Area } from "../models/area.model";
import { Article } from "../models/article.model";
import { HuntReport } from "../models/hunt-report.model";
import { AppNotification, type AppNotificationDocument } from "../models/notification.model";
import { NotifierState } from "../models/notifier-state.model";
import {
  buildArticleNotification,
  buildDeadlineNotification,
  buildFoxStatusNotification,
  diffAreaStatus,
  dueDeadlineWarnings,
  HUNT_SUBMIT_WINDOW_MS,
  type NotificationInput,
} from "./notifier.helpers";
import { sendToAll } from "./push.service";

const STATE_KEY = "notifier";

interface NotifierOptions {
  now?: Date;
  send?: (notification: AppNotificationDocument) => Promise<unknown>;
  log?: { error(message: string, error?: unknown): void };
}

/**
 * Compare the database with what was seen last and store a notification per change (fox status, new article,
 * hunt 10 minutes before its submit deadline), then push them. The first run per database only records the
 * current state, so a restart or demo switch doesn't flood everyone. State is saved after the notifications,
 * so a crash in between re-detects (a duplicate at worst) instead of losing an event.
 * @returns The created notifications
 */
export async function runNotifier(options: NotifierOptions = {}): Promise<AppNotificationDocument[]> {
  const now = options.now ?? new Date();
  const send = options.send ?? ((notification) => sendToAll(notification));
  const log = options.log ?? console;

  const state = (await NotifierState.findOne({ key: STATE_KEY })) ?? new NotifierState({ key: STATE_KEY });
  const areas = await Area.find({}, { name: 1, status: 1 }).lean();

  if (!state.initialized) {
    const latest = await Article.findOne({}, { id: 1 }).sort({ id: -1 }).lean();
    state.areaStatus = new Map(areas.map((area) => [area.name, area.status]));
    state.lastArticleId = latest?.id ?? 0;
    state.initialized = true;
    await state.save();
    return [];
  }

  const inputs: NotificationInput[] = diffAreaStatus(Object.fromEntries(state.areaStatus), areas).map(buildFoxStatusNotification);

  const articles = await Article.find({ id: { $gt: state.lastArticleId } }, { id: 1, title: 1, type: 1, endTime: 1 }).sort({ id: 1 }).lean();
  inputs.push(...articles.map(buildArticleNotification));

  // Hunt time can lie before the upload, so look back a bit further than the submit window
  const open = await HuntReport.find(
    { submittedAt: null, deadlineWarnedAt: null, createdAt: { $gte: new Date(now.getTime() - 3 * HUNT_SUBMIT_WINDOW_MS) } },
    { area: 1, huntTime: 1, createdAt: 1, reportedByName: 1, submittedAt: 1, deadlineWarnedAt: 1 },
  ).lean();
  for (const report of dueDeadlineWarnings(open, now)) {
    // Conditional claim: two overlapping runs never both warn
    const claim = await HuntReport.updateOne({ _id: report._id, deadlineWarnedAt: null }, { $set: { deadlineWarnedAt: now } });
    if (claim.modifiedCount === 1) inputs.push(buildDeadlineNotification(report, now));
  }

  const created = inputs.length > 0 ? await AppNotification.insertMany(inputs.map((input) => ({ ...input, createdAt: new Date() }))) : [];

  // Merge: areas missing from a partial read keep their last known status
  const areaStatus = new Map(state.areaStatus);
  for (const area of areas) areaStatus.set(area.name, area.status);
  state.areaStatus = areaStatus;
  if (articles.length > 0) state.lastArticleId = articles[articles.length - 1].id;
  await state.save();

  for (const notification of created) {
    send(notification).catch((error) => log.error("Pushing a notification failed", error));
  }
  return created;
}
```

- [ ] **Step 4: Cron** `src/crons/notifier.cron.ts`:

```ts
import { logger } from "..";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { runNotifier } from "../services/notifier.service";

/** Detect fox status changes, new articles and nearing hunt deadlines; runs on the active database (demo too). */
export default async function notify() {
  const generation = currentGeneration();
  try {
    const created = await runTracked(() => runNotifier({ log: logger }), { generation });
    if (created?.length) logger.info(`(CRON) Created ${created.length} notification(s): ${created.map((notification) => notification.title).join(" | ")}`);
  } catch (error) {
    logger.error("(CRON) Notifier failed", error);
  }
}
```

- [ ] **Step 5: Wire in `src/index.ts`.** Add import next to the other crons: `import notify from "./crons/notifier.cron";` and `import { isPushConfigured } from "./services/push.service";`. After the fox-prediction cron block at the end add:

```ts
// Notifications: fox status changes, new articles and hunt deadlines (push + in-app feed)
cron.schedule("*/10 * * * * *", notify, { name: "notifier", noOverlap: true });
if (!isPushConfigured()) {
  logger.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set, push notifications are off (in-app alerts still work)");
}
```

- [ ] **Step 6: Run** `npx --yes bun test src/services/notifier.service.test.ts` — PASS; full `npx --yes bun test` — all PASS; `npx --yes bun x tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/notifier.service.ts src/services/notifier.service.test.ts src/crons/notifier.cron.ts src/index.ts
git commit -m "feat(notifications): notifier cron detecting status, article and deadline events"
```

---

### Task S4: Routes (feed, preferences, push subscribe, broadcast) + demo copy

**Files:**
- Create: `src/controllers/notifications.controller.ts`
- Create: `src/controllers/notifications.controller.test.ts`
- Create: `src/routes/notifications.route.ts`
- Create: `src/routes/push.route.ts`
- Modify: `src/routes/admin.route.ts` (POST `/broadcast`)
- Modify: `src/index.ts` (mount `/notifications`, `/push`)
- Modify: `src/demo/database-switch.ts:292-293` (copy `pushsubscriptions` with users)

**Interfaces:**
- Consumes: S1 models/helpers, `sendToAll`, `vapidPublicKey` (S2).
- Produces HTTP API (client tasks rely on these exact shapes):
  - `GET /notifications?since=<ISO>` → `{ notifications: NotificationView[], serverTime: string }`; `NotificationView = { id, type, title, body, urgent, data, createdAt }`.
  - `GET /notifications/preferences` → `{ disabledTypes: string[], promptedVersion: number }`; `PUT` same body (both optional) → same shape.
  - `GET /push/vapid-key` → `{ publicKey }` or 404 `{ message }`.
  - `POST /push/subscribe` body `{ endpoint, keys: { p256dh, auth } }` → 204. `DELETE /push/subscribe` body `{ endpoint }` → 204.
  - `POST /admin/broadcast` body `{ message }` → 201 `NotificationView`.

- [ ] **Step 1: Write failing test** `src/controllers/notifications.controller.test.ts` (controllers called with fake req/res, like `articles.controller.test.ts`):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { AppNotification } from "../models/notification.model";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { broadcast, getPreferences, listNotifications, putPreferences, subscribe, unsubscribe } from "./notifications.controller";

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(body: unknown) { res.body = body; return res; }, end() { return res; } };
  return res;
}
const call = async (handler: (req: Request, res: Response) => unknown, req: Partial<Request>) => {
  const res = fakeRes();
  await handler(req as Request, res as unknown as Response);
  return res;
};

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("listNotifications", () => {
  test("without since returns nothing and the server time", async () => {
    await AppNotification.create({ type: "hint", title: "Nieuwe hint" });
    const res = await call(listNotifications, { query: {} });
    expect((res.body as { notifications: unknown[] }).notifications).toEqual([]);
    expect((res.body as { serverTime: Date }).serverTime).toBeInstanceOf(Date);
  });
  test("returns notifications after since, oldest first", async () => {
    await AppNotification.create({ type: "hint", title: "oud", createdAt: new Date("2026-10-17T19:00:00Z") });
    await AppNotification.create({ type: "hint", title: "b", createdAt: new Date("2026-10-17T20:02:00Z") });
    await AppNotification.create({ type: "hint", title: "a", createdAt: new Date("2026-10-17T20:01:00Z") });
    const res = await call(listNotifications, { query: { since: "2026-10-17T20:00:00Z" } });
    expect((res.body as { notifications: { title: string }[] }).notifications.map((n) => n.title)).toEqual(["a", "b"]);
  });
});

describe("preferences", () => {
  test("defaults, update and promptedVersion never goes down", async () => {
    const user = await User.create({ email: "a@t.nl", password: "x", name: "A" });
    expect((await call(getPreferences, { user })).body).toEqual({ disabledTypes: [], promptedVersion: 0 });
    await call(putPreferences, { user, body: { disabledTypes: ["hint"], promptedVersion: 2 } });
    const res = await call(putPreferences, { user, body: { promptedVersion: 1 } });
    expect(res.body).toEqual({ disabledTypes: ["hint"], promptedVersion: 2 });
  });
});

describe("push subscriptions", () => {
  test("subscribe upserts by endpoint and moves it to the current user", async () => {
    const a = await User.create({ email: "a@t.nl", password: "x", name: "A" });
    const b = await User.create({ email: "b@t.nl", password: "x", name: "B" });
    const body = { endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } };
    await call(subscribe, { user: a, body, get: () => "UA" } as Partial<Request>);
    await call(subscribe, { user: b, body, get: () => "UA" } as Partial<Request>);
    const all = await PushSubscription.find().lean();
    expect(all).toHaveLength(1);
    expect(all[0].user.toString()).toBe(b._id.toString());
    await call(unsubscribe, { user: b, body: { endpoint: "https://push/1" } });
    expect(await PushSubscription.countDocuments()).toBe(0);
  });
});

test("broadcast stores an urgent notification", async () => {
  const admin = await User.create({ email: "h@t.nl", password: "x", name: "HQ", admin: true });
  const res = await call(broadcast, { user: admin, body: { message: "Terug naar HQ" } });
  expect(res.statusCode).toBe(201);
  expect(await AppNotification.findOne({ type: "broadcast" }).lean()).toMatchObject({ title: "Bericht van HQ", body: "Terug naar HQ", urgent: true });
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/controllers/notifications.controller.test.ts` — FAIL.

- [ ] **Step 3: Implement** `src/controllers/notifications.controller.ts`:

```ts
import { Request, Response } from "express";
import { AppNotification, toNotificationView } from "../models/notification.model";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { buildBroadcastNotification } from "../services/notifier.helpers";
import { sendToAll, vapidPublicKey } from "../services/push.service";

const FEED_LIMIT = 50;

/** New notifications after `since`; without `since` only the server time, so a client starts at "now". */
export async function listNotifications(req: Request, res: Response) {
  const serverTime = new Date();
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : null;
  if (!since || Number.isNaN(since.getTime())) return res.status(200).json({ notifications: [], serverTime });
  const notifications = await AppNotification.find({ createdAt: { $gt: since, $lte: serverTime } })
    .sort({ createdAt: 1 })
    .limit(FEED_LIMIT)
    .lean();
  return res.status(200).json({ notifications: notifications.map(toNotificationView), serverTime });
}

function prefsOf(user: { notificationPrefs?: { disabledTypes?: string[]; promptedVersion?: number } | null }) {
  return { disabledTypes: [...(user.notificationPrefs?.disabledTypes ?? [])], promptedVersion: user.notificationPrefs?.promptedVersion ?? 0 };
}

export async function getPreferences(req: Request, res: Response) {
  return res.status(200).json(prefsOf(req.user!));
}

export async function putPreferences(req: Request, res: Response) {
  const update: Record<string, unknown> = {};
  if (Array.isArray(req.body.disabledTypes)) update.$set = { "notificationPrefs.disabledTypes": [...new Set(req.body.disabledTypes as string[])] };
  if (req.body.promptedVersion !== undefined) update.$max = { "notificationPrefs.promptedVersion": Number(req.body.promptedVersion) };
  const user = await User.findByIdAndUpdate(req.user!._id, update, { returnDocument: "after" }).lean();
  return res.status(200).json(prefsOf(user ?? req.user!));
}

export function getVapidKey(_req: Request, res: Response) {
  const publicKey = vapidPublicKey();
  if (!publicKey) return res.status(404).json({ message: "Pushmeldingen zijn niet ingesteld op de server." });
  return res.status(200).json({ publicKey });
}

/** Upsert by endpoint: a device that logs in as another user moves to that user. */
export async function subscribe(req: Request, res: Response) {
  const { endpoint, keys } = req.body;
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: req.user!._id, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: req.get?.("user-agent") },
    { upsert: true },
  );
  return res.status(204).end();
}

export async function unsubscribe(req: Request, res: Response) {
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user!._id });
  return res.status(204).end();
}

export async function broadcast(req: Request, res: Response) {
  const notification = await AppNotification.create(buildBroadcastNotification(String(req.body.message).trim(), req.user!.name));
  void sendToAll(notification);
  return res.status(201).json(toNotificationView(notification));
}
```

`src/routes/notifications.route.ts`:

```ts
import express from "express";
import { body } from "express-validator";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { OPTIONAL_NOTIFICATION_TYPES } from "../services/notifier.helpers";

const preferencesValidator = [
  body("disabledTypes").optional().isArray().withMessage("disabledTypes moet een lijst zijn."),
  body("disabledTypes.*").isIn(OPTIONAL_NOTIFICATION_TYPES).withMessage("Onbekend meldingstype."),
  body("promptedVersion").optional().isInt({ min: 0 }).withMessage("Versie moet een getal van 0 of hoger zijn.").toInt(),
];

const router = express.Router();

router.get("/", verifyToken, notificationsController.listNotifications);
router.get("/preferences", verifyToken, notificationsController.getPreferences);
router.put("/preferences", [verifyToken, validate(preferencesValidator)], notificationsController.putPreferences);

export default router;
```

`src/routes/push.route.ts`:

```ts
import express from "express";
import { body } from "express-validator";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const subscribeValidator = [
  body("endpoint").isURL({ protocols: ["https"], require_tld: false }).withMessage("Ongeldig push-adres."),
  body("keys.p256dh").isString().notEmpty().withMessage("Sleutel ontbreekt."),
  body("keys.auth").isString().notEmpty().withMessage("Sleutel ontbreekt."),
];

const router = express.Router();

router.get("/vapid-key", notificationsController.getVapidKey);
router.post("/subscribe", [verifyToken, validate(subscribeValidator)], notificationsController.subscribe);
router.delete("/subscribe", [verifyToken, validate([body("endpoint").isString().notEmpty()])], notificationsController.unsubscribe);

export default router;
```

In `src/routes/admin.route.ts` add import `import * as notificationsController from "../controllers/notifications.controller";` and, next to the other admin routes:

```ts
router.post(
  "/broadcast",
  [verifyToken, isAdmin, validate([body("message").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Bericht moet 1 tot 200 tekens zijn.")])],
  notificationsController.broadcast,
);
```

In `src/index.ts` add imports `import notificationsRoute from "./routes/notifications.route";` and `import pushRoute from "./routes/push.route";`, and after `app.use("/visits", visitsRoute);`:

```ts
app.use("/notifications", notificationsRoute);
app.use("/push", pushRoute);
```

In `src/demo/database-switch.ts`, after the users copy (line 293) add:

```ts
  // Push endpoints too, so notifications of the demo world reach the devices that were subscribed
  const pushSubscriptions = await stateStore.connection.collection("pushsubscriptions").find().toArray();
  if (pushSubscriptions.length > 0) await connection.collection("pushsubscriptions").insertMany(pushSubscriptions);
```

- [ ] **Step 4: Run** `npx --yes bun test` (all) — PASS; `npx --yes bun x tsc --noEmit`; `npx --yes bun x eslint src` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/notifications.controller.ts src/controllers/notifications.controller.test.ts src/routes/notifications.route.ts src/routes/push.route.ts src/routes/admin.route.ts src/index.ts src/demo/database-switch.ts
git commit -m "feat(notifications): feed, preferences, push subscribe and broadcast endpoints"
```

---

## Client (worktree `jotihunt-tracker-client-notifications`)

### Task C1: Notification lib, sounds, settings + feed and preference hooks

**Files:**
- Create: `src/lib/notifications.ts`, `src/lib/notifications.test.ts`
- Create: `src/assets/audio/{fox-green,fox-status,article,deadline,broadcast}.mp3` (ffmpeg)
- Create: `src/lib/notification-sounds.ts`
- Create: `src/hooks/notification-prefs.hook.ts`
- Create: `src/hooks/notification-feed.hook.ts`
- Modify: `src/stores/settings.store.ts` (`soundMuted`)
- Modify: `src/hooks/next-hint.hook.ts` (remove sound)
- Modify: `src/Layout.tsx` (mount feed)

**Interfaces:**
- Consumes: server API from S4.
- Produces: `type NotificationType`, `type OptionalNotificationType`, `interface AppNotification`, `interface NotificationPrefs`, `NOTIFICATION_OPTIONS`, `NOTIFICATIONS_PROMPT_VERSION = 1`, `shouldAlert(type, disabledTypes)`, `soundKey(notification): SoundKey`, `toastKind(notification)`, `mergeFeed(seen, incoming)`; `playNotificationSound(key)`; `useNotificationPrefs(): { prefs, disabledTypes, update(prefs: Partial<NotificationPrefs>) }`; `useNotificationFeed(options?: { respectPreferences?: boolean; onNotification?: (n: AppNotification) => void; toasts?: boolean })`; settings store `soundMuted`, `setSoundMuted`.

- [ ] **Step 1: Failing test** `src/lib/notifications.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mergeFeed, shouldAlert, soundKey, toastKind, type AppNotification } from './notifications';

const n = (overrides: Partial<AppNotification>): AppNotification => ({ id: '1', type: 'hint', title: 't', body: '', urgent: false, data: {}, createdAt: '2026-10-17T20:00:00Z', ...overrides });

describe('shouldAlert', () => {
  test('respects disabled types, broadcast always alerts', () => {
    expect(shouldAlert('hint', ['hint'])).toBe(false);
    expect(shouldAlert('hint', [])).toBe(true);
    expect(shouldAlert('broadcast', ['broadcast'])).toBe(true);
  });
});

describe('soundKey / toastKind', () => {
  test('green fox is urgent', () => {
    expect(soundKey(n({ type: 'fox-status', data: { status: 'green' } }))).toBe('fox-green');
    expect(soundKey(n({ type: 'fox-status', data: { status: 'red' } }))).toBe('fox-status');
    expect(soundKey(n({ type: 'hunt-deadline' }))).toBe('deadline');
    expect(toastKind(n({ type: 'fox-status', data: { status: 'green' } }))).toBe('success');
    expect(toastKind(n({ type: 'broadcast' }))).toBe('warning');
    expect(toastKind(n({ type: 'article' }))).toBe('info');
  });
});

describe('mergeFeed', () => {
  test('drops already seen ids and keeps the seen set bounded', () => {
    const seen = new Set(['1']);
    const fresh = mergeFeed(seen, [n({ id: '1' }), n({ id: '2' })]);
    expect(fresh.map((item) => item.id)).toEqual(['2']);
    expect(seen.has('2')).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/lib/notifications.test.ts` — FAIL.

- [ ] **Step 3: Implement** `src/lib/notifications.ts`:

```ts
export type NotificationType = 'fox-status' | 'hint' | 'article' | 'hunt-deadline' | 'broadcast';
/** Broadcasts from HQ can't be switched off */
export type OptionalNotificationType = Exclude<NotificationType, 'broadcast'>;
export type SoundKey = 'fox-green' | 'fox-status' | 'hint' | 'article' | 'deadline' | 'broadcast';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  urgent: boolean;
  data: { area?: string; status?: string; previousStatus?: string; articleId?: number; huntReportId?: string; from?: string };
  createdAt: string;
}

export interface NotificationPrefs {
  disabledTypes: OptionalNotificationType[];
  promptedVersion: number;
}

/** Bump to show the "Meldingen" dialog again to everyone (e.g. after adding a type). */
export const NOTIFICATIONS_PROMPT_VERSION = 1;

export const NOTIFICATION_OPTIONS: { type: OptionalNotificationType; label: string; description: string }[] = [
  { type: 'fox-status', label: 'Vossen status', description: 'Als een deelgebied rood, oranje of groen wordt (groen = jagen mag).' },
  { type: 'hint', label: 'Nieuwe hint', description: 'Zodra de organisatie een hint publiceert.' },
  { type: 'article', label: 'Opdrachten en nieuws', description: 'Nieuwe opdrachten en nieuwsberichten.' },
  { type: 'hunt-deadline', label: 'Hunt deadline', description: '10 minuten voordat een hunt ingestuurd moet zijn.' },
];

export function shouldAlert(type: NotificationType, disabledTypes: readonly string[]): boolean {
  return type === 'broadcast' || !disabledTypes.includes(type);
}

export function soundKey(notification: Pick<AppNotification, 'type' | 'data'>): SoundKey {
  switch (notification.type) {
    case 'fox-status':
      return notification.data.status === 'green' ? 'fox-green' : 'fox-status';
    case 'hunt-deadline':
      return 'deadline';
    default:
      return notification.type;
  }
}

export function toastKind(notification: Pick<AppNotification, 'type' | 'data'>): 'success' | 'warning' | 'info' {
  if (notification.type === 'fox-status' && notification.data.status === 'green') return 'success';
  if (notification.type === 'hunt-deadline' || notification.type === 'broadcast') return 'warning';
  return 'info';
}

const SEEN_LIMIT = 200;

/** The notifications not handled yet; marks them as seen (the feed is polled with an overlapping window). */
export function mergeFeed(seen: Set<string>, incoming: AppNotification[]): AppNotification[] {
  const fresh = incoming.filter((notification) => !seen.has(notification.id));
  for (const notification of fresh) seen.add(notification.id);
  while (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
  return fresh;
}
```

- [ ] **Step 4: Sounds.** From the worktree root:

```bash
cd src/assets/audio
ffmpeg -y -f lavfi -i "aevalsrc='0.6*sin(2*PI*(600*mod(t,0.5)+800*mod(t,0.5)*mod(t,0.5)))':d=2:s=44100" -c:a libmp3lame -q:a 4 fox-green.mp3
ffmpeg -y -f lavfi -i "aevalsrc='0.5*if(lt(mod(t,0.5),0.25),sin(2*PI*880*t),sin(2*PI*660*t))':d=1:s=44100" -c:a libmp3lame -q:a 4 fox-status.mp3
ffmpeg -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*1046*t)*exp(-4*t)+0.3*sin(2*PI*1568*t)*exp(-5*t)':d=1.2:s=44100" -c:a libmp3lame -q:a 4 article.mp3
ffmpeg -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*1000*t)*lt(mod(t,0.3),0.15)*lt(t,0.9)':d=1:s=44100" -c:a libmp3lame -q:a 4 deadline.mp3
ffmpeg -y -f lavfi -i "aevalsrc='0.5*(sin(2*PI*523*t)*lt(t,0.2)+sin(2*PI*659*t)*gte(t,0.2)*lt(t,0.4)+sin(2*PI*784*t)*gte(t,0.4)*lt(t,0.8))':d=0.9:s=44100" -c:a libmp3lame -q:a 4 broadcast.mp3
cd -
```

Expected: five files, each a few KB.

- [ ] **Step 5: Sound player** `src/lib/notification-sounds.ts`:

```ts
import foxGreen from '@/assets/audio/fox-green.mp3';
import foxStatus from '@/assets/audio/fox-status.mp3';
import hint from '@/assets/audio/hint-alert.mp3';
import article from '@/assets/audio/article.mp3';
import deadline from '@/assets/audio/deadline.mp3';
import broadcast from '@/assets/audio/broadcast.mp3';
import type { SoundKey } from './notifications';

const SOURCES: Record<SoundKey, string> = { 'fox-green': foxGreen, 'fox-status': foxStatus, hint, article, deadline, broadcast };

/** Play an alert; silently ignored when the browser blocks audio (no user interaction yet). */
export function playNotificationSound(key: SoundKey, volume = 1) {
  const audio = new Audio(SOURCES[key]);
  audio.volume = volume;
  audio.play().catch(() => {});
}
```

- [ ] **Step 6: Settings store** — in `src/stores/settings.store.ts` add to `SettingsState`: `soundMuted: boolean;` and `setSoundMuted: (soundMuted: boolean) => void;`; in the initial state `soundMuted: false,` and `setSoundMuted: (soundMuted: boolean) => { set({ soundMuted }); },`. In `migrate`, keep `soundMuted: state?.soundMuted ?? false` in the returned object. (No version bump: the field is additive.)

- [ ] **Step 7: Preferences hook** `src/hooks/notification-prefs.hook.ts`:

```ts
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod, useAuthSWR } from '@/lib/swr';
import type { NotificationPrefs } from '@/lib/notifications';

/** The user's opt-out notification settings (shared with the server for push). */
export const useNotificationPrefs = () => {
  const authHeader = useAuthHeader() || '';
  const { data, mutate } = useAuthSWR<NotificationPrefs>('/notifications/preferences', { refreshInterval: 60_000 });

  /** Throws the axios error on failure. */
  async function update(prefs: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
    const result = (await fetcherWithMethod('/notifications/preferences', authHeader, 'PUT', prefs)) as NotificationPrefs;
    await mutate(result, { revalidate: false });
    return result;
  }

  return { prefs: data, disabledTypes: data?.disabledTypes ?? [], update };
};
```

- [ ] **Step 8: Feed hook** `src/hooks/notification-feed.hook.ts`:

```ts
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod } from '@/lib/swr';
import { mergeFeed, shouldAlert, soundKey, toastKind, type AppNotification } from '@/lib/notifications';
import { playNotificationSound } from '@/lib/notification-sounds';
import { useNotificationPrefs } from '@/hooks/notification-prefs.hook';
import useSettingsStore from '@/stores/settings.store';

const POLL_MS = 5000;
/** Re-ask this far back each poll: a notification can be stored just after a poll read the server time. */
const OVERLAP_MS = 20_000;

interface FeedOptions {
  /** false on the HQ screen: alert on every type */
  respectPreferences?: boolean;
  toasts?: boolean;
  onNotification?: (notification: AppNotification) => void;
}

/**
 * Poll the server's notification feed and alert (sound + toast) for new ones. Starts at "now": notifications
 * from before the page loaded are never replayed.
 */
export function useNotificationFeed({ respectPreferences = true, toasts = true, onNotification }: FeedOptions = {}) {
  const authHeader = useAuthHeader() || '';
  const { disabledTypes } = useNotificationPrefs();
  const soundMuted = useSettingsStore((state) => state.soundMuted);

  // Read inside the interval, so changing a setting doesn't restart polling
  const latest = useRef({ disabledTypes, soundMuted, respectPreferences, toasts, onNotification });
  useEffect(() => {
    latest.current = { disabledTypes, soundMuted, respectPreferences, toasts, onNotification };
  });

  useEffect(() => {
    if (!authHeader) return;
    let cursor: string | null = null;
    let busy = false;
    const seen = new Set<string>();

    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const since = cursor ? `?since=${encodeURIComponent(new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString())}` : '';
        const response = (await fetcherWithMethod(`/notifications${since}`, authHeader)) as { notifications: AppNotification[]; serverTime: string };
        const fresh = cursor ? mergeFeed(seen, response.notifications) : [];
        cursor = response.serverTime;
        const options = latest.current;
        let played = false;
        for (const notification of fresh) {
          if (options.respectPreferences && !shouldAlert(notification.type, options.disabledTypes)) continue;
          // One sound per poll: several events at once would play on top of each other
          if (!options.soundMuted && !played) {
            playNotificationSound(soundKey(notification));
            played = true;
          }
          if (options.toasts) {
            toast[toastKind(notification)](notification.title, { description: notification.body || undefined, duration: notification.urgent ? 30_000 : 8000 });
          }
          options.onNotification?.(notification);
        }
      } catch {
        // Next poll retries; the cursor only advances on success
      } finally {
        busy = false;
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(interval);
  }, [authHeader]);
}
```

- [ ] **Step 9: Remove hint sound** in `src/hooks/next-hint.hook.ts`: delete the `useSound` and `hintAlert` imports, delete `const [play] = useSound(hintAlert);`, delete the `play();` call, and change the doc comment to `Countdown to the next hint, plus a highlight when a new hint arrives (not on the first load). The sound comes from the notification feed.`

- [ ] **Step 10: Mount** in `src/Layout.tsx`: add `import {useNotificationFeed} from '@/hooks/notification-feed.hook';` and call `useNotificationFeed();` right after `useTheme();`.

- [ ] **Step 11: Verify** `npx --yes bun test src/lib` PASS; `npx --yes bun x tsc -b` clean; `npx --yes bun x eslint src/lib/notifications.ts src/lib/notification-sounds.ts src/hooks/notification-feed.hook.ts src/hooks/notification-prefs.hook.ts src/hooks/next-hint.hook.ts src/stores/settings.store.ts src/Layout.tsx` clean.

- [ ] **Step 12: Commit**

```bash
git add src/lib/notifications.ts src/lib/notifications.test.ts src/lib/notification-sounds.ts src/assets/audio src/hooks/notification-feed.hook.ts src/hooks/notification-prefs.hook.ts src/hooks/next-hint.hook.ts src/stores/settings.store.ts src/Layout.tsx
git commit -m "feat(notifications): in-app notification feed with per-type sounds and toasts"
```

---

### Task C2: Service worker push + subscription lib

**Files:**
- Create: `public/push-sw.js`
- Modify: `vite.config.ts` (`workbox.importScripts`)
- Create: `src/lib/push.ts`, `src/lib/push.test.ts`
- Modify: `src/Layout.tsx` (re-sync existing subscription on load)

**Interfaces:**
- Consumes: `/push/vapid-key`, `/push/subscribe` (S4).
- Produces: `isPushSupported()`, `isIos(userAgent)`, `needsIosInstall(userAgent, standalone)`, `isStandalone()`, `urlBase64ToUint8Array(base64)`, `type Fetch`, `type PushResult = 'subscribed' | 'denied' | 'unsupported' | 'unavailable' | 'error'`, `subscribePush(fetch): Promise<PushResult>`, `resyncPush(fetch): Promise<void>`, `pushPermission(): NotificationPermission | 'unsupported'`.

- [ ] **Step 1: Failing test** `src/lib/push.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { isIos, needsIosInstall, urlBase64ToUint8Array } from './push';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';

test('iOS needs the app on the home screen for push', () => {
  expect(isIos(IPHONE)).toBe(true);
  expect(isIos(ANDROID)).toBe(false);
  expect(needsIosInstall(IPHONE, false)).toBe(true);
  expect(needsIosInstall(IPHONE, true)).toBe(false);
  expect(needsIosInstall(ANDROID, false)).toBe(false);
});

test('urlBase64ToUint8Array decodes url-safe base64', () => {
  expect([...urlBase64ToUint8Array('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/lib/push.test.ts` — FAIL.

- [ ] **Step 3: Implement** `src/lib/push.ts`:

```ts
import type { AxiosResponse } from 'axios';

export type Fetch = <T>(url: string, method?: 'GET' | 'POST' | 'DELETE' | 'PUT', body?: unknown) => Promise<AxiosResponse<T>>;
export type PushResult = 'subscribed' | 'denied' | 'unsupported' | 'unavailable' | 'error';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIos(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent);
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iOS only allows push for an app added to the home screen. */
export function needsIosInstall(userAgent: string, standalone: boolean): boolean {
  return isIos(userAgent) && !standalone;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return isPushSupported() ? Notification.permission : 'unsupported';
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** Ask permission (must run from a click) and register this device for push. */
export async function subscribePush(fetch: Fetch): Promise<PushResult> {
  if (!isPushSupported()) return 'unsupported';
  let publicKey: string;
  try {
    publicKey = (await fetch<{ publicKey: string }>('/push/vapid-key')).data.publicKey;
  } catch {
    return 'unavailable';
  }
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    await fetch('/push/subscribe', 'POST', subscription.toJSON());
    return 'subscribed';
  } catch (error) {
    console.warn('[push] subscribe failed', error);
    return 'error';
  }
}

/** On load: send an existing subscription again, so it belongs to the logged-in user (and survives a demo switch). */
export async function resyncPush(fetch: Fetch): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await fetch('/push/subscribe', 'POST', subscription.toJSON());
  } catch (error) {
    console.warn('[push] resync failed', error);
  }
}
```

- [ ] **Step 4: Service worker** `public/push-sw.js`:

```js
/* Push handling, imported into the generated Workbox service worker (vite.config.ts → workbox.importScripts). */

const IOS = /iPad|iPhone|iPod/.test(self.navigator.userAgent);

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // A focused app plays the sound and shows a toast itself. iOS revokes subscriptions whose pushes show
      // nothing, so there a notification is always shown.
      if (!IOS && windows.some((client) => client.focused)) return;
      await self.registration.showNotification(payload.title || 'Jotihunt Tracker', {
        body: payload.body || '',
        icon: '/pwa-192x192.png',
        badge: '/pwa-64x64.png',
        tag: `${payload.type || 'melding'}-${payload.id || Date.now()}`,
        requireInteraction: !!payload.urgent,
        data: { url: payload.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
```

- [ ] **Step 5: vite.config.ts** — in `pwaManifest.workbox` add `importScripts: ['push-sw.js'],` after `maximumFileSizeToCacheInBytes`.

- [ ] **Step 6: Resync on load** in `src/Layout.tsx`: add imports `import {useFetcher} from '@/hooks/utils/api.hook';` and `import {resyncPush} from '@/lib/push';`; inside the component after `useNotificationFeed();`:

```tsx
    const {fetch} = useFetcher();
    useEffect(() => {
        void resyncPush(fetch);
        // Once per page load
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
```

- [ ] **Step 7: Verify** `npx --yes bun test src/lib/push.test.ts` PASS; `npx --yes bun x tsc -b` clean; `npx --yes bun x vite build` succeeds and `grep -c push-sw dist/sw.js` ≥ 1.

- [ ] **Step 8: Commit**

```bash
git add public/push-sw.js vite.config.ts src/lib/push.ts src/lib/push.test.ts src/Layout.tsx
git commit -m "feat(notifications): service worker push handler and device subscription"
```

---

### Task C3: Meldingen dialog, settings items, admin broadcast

**Files:**
- Create: `src/stores/notifications-dialog.store.ts`
- Create: `src/components/notifications/NotificationsDialog.tsx`
- Create: `src/components/notifications/useNotificationsPrompt.ts`
- Create: `src/components/admin/BroadcastDialog.tsx`
- Modify: `src/stores/admin.store.ts` (`'broadcast'` id)
- Modify: `src/components/Settings.tsx` (Meldingen, Geluid, Bericht versturen, HQ-scherm)
- Modify: `src/Layout.tsx` (mount dialogs + prompt)

**Interfaces:**
- Consumes: C1 (`NOTIFICATION_OPTIONS`, `NOTIFICATIONS_PROMPT_VERSION`, `useNotificationPrefs`, settings `soundMuted`), C2 (`subscribePush`, `isPushSupported`, `needsIosInstall`, `isStandalone`, `pushPermission`).
- Produces: `useNotificationsDialogStore` `{ open: boolean; setOpen(open: boolean) }`; `useNotificationsPrompt(blocked: boolean)`.

- [ ] **Step 1: Store** `src/stores/notifications-dialog.store.ts`:

```ts
import { create } from 'zustand';

interface NotificationsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** The "Meldingen" dialog: opened automatically once (see useNotificationsPrompt) and from Settings. */
const useNotificationsDialogStore = create<NotificationsDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export default useNotificationsDialogStore;
```

- [ ] **Step 2: Dialog** `src/components/notifications/NotificationsDialog.tsx`:

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import ResponsiveDialog from '@/components/ResponsiveDialog';
import { useFetcher } from '@/hooks/utils/api.hook';
import { useNotificationPrefs } from '@/hooks/notification-prefs.hook';
import { NOTIFICATION_OPTIONS, NOTIFICATIONS_PROMPT_VERSION, type OptionalNotificationType } from '@/lib/notifications';
import { isPushSupported, isStandalone, needsIosInstall, pushPermission, subscribePush, type PushResult } from '@/lib/push';
import useNotificationsDialogStore from '@/stores/notifications-dialog.store';

const RESULT_MESSAGE: Record<Exclude<PushResult, 'subscribed'>, string> = {
  denied: 'Meldingen zijn geblokkeerd. Zet ze aan in de instellingen van je browser; geluiden in de app werken wel.',
  unsupported: 'Deze browser ondersteunt geen pushmeldingen; geluiden in de app werken wel.',
  unavailable: 'Pushmeldingen zijn niet ingesteld op de server; geluiden in de app werken wel.',
  error: 'Aanmelden voor pushmeldingen is mislukt, probeer het later opnieuw.',
};

/** Choose which notifications to get (all on by default) and register this device for push. */
export default function NotificationsDialog() {
  const open = useNotificationsDialogStore((state) => state.open);
  const setOpen = useNotificationsDialogStore((state) => state.setOpen);
  const { prefs, update } = useNotificationPrefs();
  const { fetch } = useFetcher();
  const [disabled, setDisabled] = useState<OptionalNotificationType[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Local edits start from the server prefs each time the dialog opens
  const current = disabled ?? prefs?.disabledTypes ?? [];
  const iosInstall = needsIosInstall(navigator.userAgent, isStandalone());

  function toggle(type: OptionalNotificationType, on: boolean) {
    setDisabled(on ? current.filter((item) => item !== type) : [...current, type]);
  }

  async function close() {
    setOpen(false);
    setDisabled(null);
    // Closing counts as "seen" too, so the dialog doesn't come back on every open
    if ((prefs?.promptedVersion ?? 0) < NOTIFICATIONS_PROMPT_VERSION) {
      await update({ promptedVersion: NOTIFICATIONS_PROMPT_VERSION }).catch(() => {});
    }
  }

  async function save() {
    setSaving(true);
    try {
      await update({ disabledTypes: current, promptedVersion: NOTIFICATIONS_PROMPT_VERSION });
      const wantsPush = current.length < NOTIFICATION_OPTIONS.length;
      if (wantsPush && !iosInstall && isPushSupported()) {
        const result = await subscribePush(fetch);
        if (result === 'subscribed') toast.success('Meldingen opgeslagen', { description: 'Je krijgt pushmeldingen op dit apparaat.' });
        else toast.warning('Meldingen opgeslagen', { description: RESULT_MESSAGE[result] });
      } else {
        toast.success('Meldingen opgeslagen');
      }
      setOpen(false);
      setDisabled(null);
    } catch {
      toast.error('Opslaan is mislukt, probeer het opnieuw.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResponsiveDialog open={open} onClose={() => void close()} title="Meldingen" description="Kies waarvoor je een melding en geluid krijgt. Alles staat standaard aan." className="sm:max-w-md">
      <div className="flex flex-col gap-4 px-4 pb-4 md:px-0 md:pb-0">
        {NOTIFICATION_OPTIONS.map((option) => (
          <div key={option.type} className="flex items-start justify-between gap-4">
            <Label htmlFor={`notification-${option.type}`} className="flex flex-col items-start gap-0.5">
              <span className="font-medium">{option.label}</span>
              <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
            </Label>
            <Switch id={`notification-${option.type}`} checked={!current.includes(option.type)} onCheckedChange={(on) => toggle(option.type, on)} />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Berichten van HQ krijg je altijd.</p>
        {iosInstall && (
          <p className="rounded-md border bg-muted/50 p-2 text-xs">
            Op een iPhone werken pushmeldingen alleen als de app op je beginscherm staat: tik op <strong>Deel</strong> en dan <strong>Zet op beginscherm</strong>. Geluiden in de app werken wel.
          </p>
        )}
        {!iosInstall && pushPermission() === 'denied' && <p className="rounded-md border bg-muted/50 p-2 text-xs">{RESULT_MESSAGE.denied}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void close()}>
            Later
          </Button>
          <Button onClick={() => void save()} disabled={saving || !prefs}>
            Opslaan
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 3: Auto prompt** `src/components/notifications/useNotificationsPrompt.ts`:

```ts
import { useEffect } from 'react';
import { useNotificationPrefs } from '@/hooks/notification-prefs.hook';
import { NOTIFICATIONS_PROMPT_VERSION } from '@/lib/notifications';
import useNotificationsDialogStore from '@/stores/notifications-dialog.store';

const PROMPT_DELAY_MS = 1500;

/** Open the "Meldingen" dialog once per NOTIFICATIONS_PROMPT_VERSION, when nothing else (tour, password) is in the way. */
export function useNotificationsPrompt(blocked: boolean) {
  const { prefs } = useNotificationPrefs();
  const setOpen = useNotificationsDialogStore((state) => state.setOpen);
  const due = !!prefs && prefs.promptedVersion < NOTIFICATIONS_PROMPT_VERSION;

  useEffect(() => {
    if (!due || blocked) return;
    const timeout = setTimeout(() => setOpen(true), PROMPT_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [due, blocked, setOpen]);
}
```

- [ ] **Step 4: Broadcast dialog.** In `src/stores/admin.store.ts` change `export type AdminDialogId = 'hunters' | 'users';` to `export type AdminDialogId = 'hunters' | 'users' | 'broadcast';`. Create `src/components/admin/BroadcastDialog.tsx`:

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import useAuthUser from 'react-auth-kit/hooks/useAuthUser';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import ResponsiveDialog from '@/components/ResponsiveDialog';
import { useFetcher } from '@/hooks/utils/api.hook';
import useAdminStore from '@/stores/admin.store';
import type { User } from '@/types/User';

const MAX_LENGTH = 200;

/** Settings → Admin tools → Bericht versturen: push + sound to everyone (can't be switched off). */
export default function BroadcastDialog() {
  const user = useAuthUser<User>();
  const open = useAdminStore((state) => state.dialog === 'broadcast');
  const close = useAdminStore((state) => state.close);
  const { fetch } = useFetcher();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  if (!user?.admin) return null;

  async function send() {
    setSending(true);
    try {
      await fetch('/admin/broadcast', 'POST', { message: message.trim() });
      toast.success('Bericht verstuurd');
      setMessage('');
      close();
    } catch {
      toast.error('Versturen is mislukt, probeer het opnieuw.');
    } finally {
      setSending(false);
    }
  }

  return (
    <ResponsiveDialog open={open} onClose={close} title="Bericht versturen" description="Iedereen krijgt dit als melding met geluid." className="sm:max-w-md">
      <div className="flex flex-col gap-3 px-4 pb-4 md:px-0 md:pb-0">
        <Textarea value={message} maxLength={MAX_LENGTH} onChange={(event) => setMessage(event.target.value)} placeholder="Bijv. Iedereen terug naar HQ" rows={3} />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {message.length}/{MAX_LENGTH}
          </span>
          <Button onClick={() => void send()} disabled={sending || message.trim().length === 0}>
            Versturen
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
```

- [ ] **Step 5: Settings menu** in `src/components/Settings.tsx`:
  - Add icons `BellIcon, Volume2Icon, MegaphoneIcon, MonitorIcon` to the `lucide-react` import.
  - Add imports: `import useNotificationsDialogStore from '@/stores/notifications-dialog.store';`.
  - In the component body (near `openHintBoard`): `const openNotifications = useNotificationsDialogStore((state) => state.setOpen);` and `const {soundMuted, setSoundMuted} = useSettingsStore();` — if `useSettingsStore()` is already destructured in this component, add `soundMuted, setSoundMuted` to that destructuring instead.
  - Directly after the "Hint board" `DropdownMenuItem`:

```tsx
                    <DropdownMenuItem onClick={() => openNotifications(true)}>
                        <BellIcon/>
                        Meldingen
                    </DropdownMenuItem>
                    <DropdownMenuCheckboxItem checked={!soundMuted}
                                              onCheckedChange={(checked) => setSoundMuted(!checked)}
                                              onSelect={(e) => e.preventDefault()}>
                        <Volume2Icon/>
                        Geluid
                    </DropdownMenuCheckboxItem>
```

  - In the Admin tools sub-content, after the "Gebruikers" item:

```tsx
                                        <DropdownMenuItem onClick={() => openAdminDialog('broadcast')}>
                                            <MegaphoneIcon/>Bericht versturen
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => window.open('/hq', '_blank', 'noopener')}>
                                            <MonitorIcon/>HQ-scherm
                                        </DropdownMenuItem>
```

- [ ] **Step 6: Layout** in `src/Layout.tsx`: imports `NotificationsDialog`, `BroadcastDialog`, `useNotificationsPrompt`; after `const tour = useTourAutoStart();` add `useNotificationsPrompt(tour.pending || requiresPasswordChange);` (move the `requiresPasswordChange` const above this line if needed). Render `<NotificationsDialog/>` and `<BroadcastDialog/>` next to `<UsersDialog/>`.

- [ ] **Step 7: Verify** `npx --yes bun x tsc -b` clean; `npx --yes bun x eslint src/components/notifications src/components/admin/BroadcastDialog.tsx src/components/Settings.tsx src/Layout.tsx src/stores` clean; `npx --yes bun test` all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stores/notifications-dialog.store.ts src/stores/admin.store.ts src/components/notifications src/components/admin/BroadcastDialog.tsx src/components/Settings.tsx src/Layout.tsx
git commit -m "feat(notifications): Meldingen dialog, sound toggle and admin broadcast"
```

---

### Task C4: HQ wall display `/hq`

**Files:**
- Modify: `src/components/Map.tsx` (optional `className` prop)
- Modify: `src/lib/hunt-reports.ts` (+ test) — `totalPoints(items)`
- Create: `src/lib/hq.ts`, `src/lib/hq.test.ts`
- Create: `src/components/hq/{HqClock,AreaTiles,HuntFeed,LatestArticle,AlertBanner,AudioUnlock}.tsx`
- Create: `src/pages/Hq.tsx`
- Modify: `src/Routes.tsx`

**Interfaces:**
- Consumes: `useNotificationFeed` (C1), `playNotificationSound`; existing `useAreas`, `useHunts`, `useHuntReports`, `usePredictions`, `usePredictionSetting`, `useArticles`, `useNextHint`, `lastHuntTimeFor`, `huntCooldownMs`, `huntListItems`, `HuntStatusBadge`, `CONFIDENCE_LABEL`, `formatHintCountdown`, `capitalizeFirstLetter`, `getColorFromArea`.
- Produces: `totalPoints(items: HuntListItem[]): number`; `bannerClass(notification): string`; `latestNonHintArticle(articles)`.

- [ ] **Step 1: Failing tests.** Append to `src/lib/hunt-reports.test.ts`:

```ts
import { totalPoints } from './hunt-reports';

test('totalPoints sums site points of reports and website hunts', () => {
  const items = [
    { source: 'app', report: { site: { points: 5 } } },
    { source: 'app', report: { site: null } },
    { source: 'website', hunt: { points: 3 } },
  ] as unknown as Parameters<typeof totalPoints>[0];
  expect(totalPoints(items)).toBe(8);
});
```

(Merge the import into the file's existing import from `./hunt-reports`; reuse its existing `test`/`expect` import.)

Create `src/lib/hq.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { bannerClass, latestNonHintArticle } from './hq';
import type { Article } from '@/types/Article';

test('bannerClass per type', () => {
  expect(bannerClass({ type: 'fox-status', data: { status: 'green' } })).toContain('bg-green');
  expect(bannerClass({ type: 'fox-status', data: { status: 'red' } })).toContain('bg-red');
  expect(bannerClass({ type: 'article', data: {} })).toContain('bg-blue');
  expect(bannerClass({ type: 'hunt-deadline', data: {} })).toContain('bg-orange');
  expect(bannerClass({ type: 'broadcast', data: {} })).toContain('bg-purple');
});

test('latestNonHintArticle skips hints', () => {
  const article = (id: number, type: string, publishAt: string) => ({ id, type, title: `${id}`, publishAt }) as unknown as Article;
  expect(latestNonHintArticle([article(1, 'news', '2026-10-17T18:00:00Z'), article(2, 'hint', '2026-10-17T19:00:00Z'), article(3, 'assignment', '2026-10-17T18:30:00Z')])?.id).toBe(3);
  expect(latestNonHintArticle([])).toBeUndefined();
});
```

- [ ] **Step 2: Run** `npx --yes bun test src/lib/hq.test.ts src/lib/hunt-reports.test.ts` — FAIL.

- [ ] **Step 3: Implement.** In `src/lib/hunt-reports.ts` add:

```ts
/** Points of a hunt list: the jotihunt.nl result of own reports, plus website-only hunts. */
export function totalPoints(items: HuntListItem[]): number {
  return items.reduce((sum, item) => sum + (item.source === 'app' ? (item.report.site?.points ?? 0) : item.hunt.points), 0);
}
```

(`HuntListItem` is already imported/used in this file by `huntListItems`; if not, import it from `@/types/HuntReport`.)

`src/lib/hq.ts`:

```ts
import type { AppNotification } from './notifications';
import type { Article } from '@/types/Article';

/** Full-screen banner colour on the HQ screen. */
export function bannerClass(notification: Pick<AppNotification, 'type' | 'data'>): string {
  if (notification.type === 'fox-status') {
    if (notification.data.status === 'green') return 'bg-green-600 text-white';
    if (notification.data.status === 'orange') return 'bg-orange-500 text-white';
    return 'bg-red-600 text-white';
  }
  if (notification.type === 'hunt-deadline') return 'bg-orange-500 text-white';
  if (notification.type === 'broadcast') return 'bg-purple-700 text-white';
  return 'bg-blue-600 text-white';
}

export function latestNonHintArticle(articles: Article[] | undefined): Article | undefined {
  return (articles ?? [])
    .filter((article) => article.type !== 'hint')
    .reduce<Article | undefined>((latest, article) => (!latest || new Date(article.publishAt) > new Date(latest.publishAt) ? article : latest), undefined);
}
```

- [ ] **Step 4: Map className.** In `src/components/Map.tsx` change `const Map = forwardRef<MapRef>((_, ref) => {` to `const Map = forwardRef<MapRef, { className?: string }>(({className}, ref) => {` and the wrapper `<div className="w-dvw h-dvh" ...>` to `<div className={className ?? "w-dvw h-dvh"} ...>`.

- [ ] **Step 5: Components.**

`src/components/hq/HqClock.tsx`:

```tsx
import { useState } from 'react';
import useInterval from '@/hooks/utils/interval.hook';
import { useNextHint } from '@/hooks/next-hint.hook';
import { cn } from '@/lib/utils';

export default function HqClock() {
  const [now, setNow] = useState(() => new Date());
  useInterval(() => setNow(new Date()), 1000);
  const { label, isUrgent, isNewHint } = useNextHint();
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="font-mono text-6xl font-bold tabular-nums leading-none">{now.toLocaleTimeString('nl-NL')}</div>
      <div className="text-right">
        <div className="text-xs uppercase text-muted-foreground">Volgende hint</div>
        <div className={cn('font-mono text-3xl font-semibold tabular-nums', isUrgent && 'text-orange-500', isNewHint && 'text-green-500')}>{label}</div>
      </div>
    </div>
  );
}
```

`src/components/hq/AreaTiles.tsx`:

```tsx
import { useState } from 'react';
import { useAreas } from '@/hooks/areas.hook';
import { useHunts } from '@/hooks/hunts.hook';
import { useHuntReports } from '@/hooks/hunt-reports.hook';
import { usePredictions, usePredictionSetting } from '@/hooks/predictions.hook';
import useInterval from '@/hooks/utils/interval.hook';
import { huntCooldownMs, lastHuntTimeFor } from '@/lib/fox-status';
import { formatHintCountdown } from '@/lib/next-hint';
import { CONFIDENCE_LABEL, formatClock } from '@/lib/prediction';
import { capitalizeFirstLetter, cn, getColorFromArea } from '@/lib/utils';

const TILE_CLASS: Record<string, string> = {
  green: 'border-green-500 bg-green-500/15',
  orange: 'border-orange-500 bg-orange-500/15',
  red: 'border-red-500 bg-red-500/15',
};
const STATUS_LABEL: Record<string, string> = { green: 'Groen', orange: 'Oranje', red: 'Rood' };

const timeOf = (time: Date | string) => new Date(time).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

export default function AreaTiles() {
  const { areas } = useAreas();
  const { hunts } = useHunts();
  const { reports } = useHuntReports();
  const { enabled: predictionEnabled } = usePredictionSetting();
  const { predictions } = usePredictions();
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 1000);

  return (
    <div className="grid grid-cols-3 gap-2">
      {(areas ?? []).map((area) => {
        const lastHunt = lastHuntTimeFor(hunts, area.name, reports);
        const cooldown = huntCooldownMs(lastHunt, now);
        const prediction = predictions?.find((item) => item.area.toLowerCase() === area.name.toLowerCase());
        return (
          <div key={area._id} className={cn('rounded-lg border-2 p-2', TILE_CLASS[area.status] ?? 'border-gray-400')}>
            <div className="flex items-center gap-1.5 text-lg font-bold">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: getColorFromArea(area.name) }} />
              {capitalizeFirstLetter(area.name)}
            </div>
            <div className="text-sm font-medium">{cooldown > 0 ? <span className="text-blue-500 tabular-nums">Cooldown {formatHintCountdown(cooldown)}</span> : (STATUS_LABEL[area.status] ?? area.status)}</div>
            <div className="text-xs text-muted-foreground">Hunt: {lastHunt ? timeOf(lastHunt) : '–'}</div>
            {predictionEnabled !== false && prediction?.lastObservation && (
              <div className="text-xs text-muted-foreground">
                {prediction.lastObservation.kind}: {formatClock(prediction.lastObservation.time)}
              </div>
            )}
            {predictionEnabled !== false && prediction?.confidence && <div className="text-xs text-muted-foreground">{CONFIDENCE_LABEL[prediction.confidence]}</div>}
          </div>
        );
      })}
    </div>
  );
}
```

`src/components/hq/HuntFeed.tsx`:

```tsx
import { useState } from 'react';
import { useHunts } from '@/hooks/hunts.hook';
import { useHuntReports } from '@/hooks/hunt-reports.hook';
import useInterval from '@/hooks/utils/interval.hook';
import HuntStatusBadge from '@/components/hunts/HuntStatusBadge';
import { formatHuntTime, huntListItems, totalPoints } from '@/lib/hunt-reports';
import { capitalizeFirstLetter } from '@/lib/utils';

const FEED_SIZE = 6;

export default function HuntFeed() {
  const { reports } = useHuntReports();
  const { hunts } = useHunts();
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 1000);
  const items = huntListItems(reports, hunts);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground">Hunts</h2>
        <span className="text-sm font-semibold">
          {items.length} hunts · {totalPoints(items)} pt
        </span>
      </div>
      {(reports ?? []).slice(0, FEED_SIZE).map((report) => (
        <div key={report._id} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">
            <strong>{capitalizeFirstLetter(report.area)}</strong> · {formatHuntTime(report.huntTime)} · {report.reportedByName}
          </span>
          <HuntStatusBadge report={report} now={now} />
        </div>
      ))}
      {reports?.length === 0 && <p className="text-sm text-muted-foreground">Nog geen hunts.</p>}
    </div>
  );
}
```

`src/components/hq/LatestArticle.tsx`:

```tsx
import { useState } from 'react';
import { useArticles } from '@/hooks/articles.hook';
import useInterval from '@/hooks/utils/interval.hook';
import { latestNonHintArticle } from '@/lib/hq';
import { formatHintCountdown } from '@/lib/next-hint';

const TYPE_LABEL: Record<string, string> = { assignment: 'Opdracht', news: 'Nieuws' };

export default function LatestArticle() {
  const { articles } = useArticles();
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 1000);
  const article = latestNonHintArticle(articles);
  if (!article) return <p className="text-sm text-muted-foreground">Nog geen opdrachten of nieuws.</p>;
  const left = article.endTime ? new Date(article.endTime).getTime() - now : 0;

  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">
        {TYPE_LABEL[article.type] ?? article.type} · {new Date(article.publishAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="text-lg font-semibold leading-tight">{article.title}</div>
      {left > 0 && <div className="text-sm tabular-nums text-orange-500">Deadline over {formatHintCountdown(left)}</div>}
    </div>
  );
}
```

`src/components/hq/AlertBanner.tsx`:

```tsx
import type { AppNotification } from '@/lib/notifications';
import { bannerClass } from '@/lib/hq';
import { cn } from '@/lib/utils';

/** Full-screen alert on the HQ screen; click to dismiss early. */
export default function AlertBanner({ notification, onDismiss }: { notification: AppNotification | null; onDismiss: () => void }) {
  if (!notification) return null;
  return (
    <button type="button" onClick={onDismiss} className={cn('fixed inset-0 z-50 flex animate-pulse flex-col items-center justify-center gap-4 p-8 text-center', bannerClass(notification))}>
      <div className="text-7xl font-black leading-tight">{notification.title}</div>
      {notification.body && <div className="text-3xl font-medium">{notification.body}</div>}
    </button>
  );
}
```

`src/components/hq/AudioUnlock.tsx`:

```tsx
import { Volume2Icon } from 'lucide-react';

/** Browsers block sound until the first click; the HQ screen asks for one. */
export default function AudioUnlock({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button type="button" onClick={onUnlock} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 text-white">
      <Volume2Icon className="size-16" />
      <span className="text-2xl font-semibold">Klik om geluid aan te zetten</span>
    </button>
  );
}
```

- [ ] **Step 6: Page** `src/pages/Hq.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import useAuthUser from 'react-auth-kit/hooks/useAuthUser';
import Map from '@/components/Map';
import HqClock from '@/components/hq/HqClock';
import AreaTiles from '@/components/hq/AreaTiles';
import HuntFeed from '@/components/hq/HuntFeed';
import LatestArticle from '@/components/hq/LatestArticle';
import AlertBanner from '@/components/hq/AlertBanner';
import AudioUnlock from '@/components/hq/AudioUnlock';
import { useNotificationFeed } from '@/hooks/notification-feed.hook';
import { useTheme } from '@/hooks/theme.hook';
import type { AppNotification } from '@/lib/notifications';
import type { User } from '@/types/User';

const BANNER_MS = 8000;

/** Admin-only wall display for the HQ TV: map, area tiles, hunts, latest article, loud alerts for everything. */
export default function Hq() {
  const user = useAuthUser<User>();
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [banner, setBanner] = useState<AppNotification | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useTheme();

  useNotificationFeed({
    respectPreferences: false,
    toasts: false,
    onNotification: (notification) => {
      setBanner(notification);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setBanner(null), BANNER_MS);
    },
  });
  useEffect(() => () => clearTimeout(timeout.current), []);

  if (!user?.admin) return <Navigate to="/" replace />;

  return (
    <div className="grid h-dvh w-dvw grid-cols-[65fr_35fr] overflow-hidden bg-background text-foreground">
      <Map className="relative h-full w-full" />
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l p-4">
        <HqClock />
        <AreaTiles />
        <HuntFeed />
        <LatestArticle />
      </aside>
      <AlertBanner notification={banner} onDismiss={() => setBanner(null)} />
      {!audioUnlocked && <AudioUnlock onUnlock={() => setAudioUnlocked(true)} />}
    </div>
  );
}
```

- [ ] **Step 7: Route** in `src/Routes.tsx`: `import Hq from './pages/Hq';` and inside `<Route element={<AuthOutlet fallbackPath="/login" />}>`, as a sibling before the `Layout` route: `<Route path="/hq" element={<Hq />} />`.

- [ ] **Step 8: Verify** `npx --yes bun test` all PASS; `npx --yes bun x tsc -b` clean; `npx --yes bun x eslint src/components/hq src/pages/Hq.tsx src/lib/hq.ts src/components/Map.tsx src/Routes.tsx src/lib/hunt-reports.ts` clean; `npx --yes bun x vite build` succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/components/Map.tsx src/lib/hunt-reports.ts src/lib/hunt-reports.test.ts src/lib/hq.ts src/lib/hq.test.ts src/components/hq src/pages/Hq.tsx src/Routes.tsx
git commit -m "feat(hq): admin wall display with area tiles, hunt feed and full-screen alerts"
```

---

### Task E2E: Manual smoke test (controller, after all tasks)

- [ ] Start a local server on PORT 3100 against a throwaway DB (`MONGO_URI=mongodb://localhost:27017/jotihunt-notify-smoke`, `JOTIHUNT_API_URL=http://127.0.0.1:9`, generated VAPID keys) and the client dev server pointed at it.
- [ ] Insert an Area, wait one notifier run, flip its status to green in Mongo → toast + sound in the app within ~15 s, `/hq` shows the green banner.
- [ ] Insert an Article with a new id, type `assignment` → "Nieuwe opdracht" toast; `/hq` latest article updates.
- [ ] Settings → Meldingen: switch off "Nieuwe hint", save → `GET /notifications/preferences` shows `["hint"]`.
- [ ] Admin broadcast → toast for everyone, banner on `/hq`.
- [ ] Non-admin opening `/hq` is redirected to `/`.
