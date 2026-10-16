# Beheer settings instead of env — server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins set hunt window, team identity, vehicle groups, Gemini key + per-feature models, Jotihunt site login and Telegram app credentials from Beheer instead of env, with env as fallback.

**Architecture:** One `app-config` document in the real database's `settings` collection, cached in memory, resolved DB → env → default with a `source` per value. Secrets are AES-256-GCM encrypted with a new `SETTINGS_KEY`. Services read the getters at use time (no module-level snapshots) and listen to a change emitter where they hold state (Telegram, scraper).

**Tech Stack:** Bun, Express 5, Mongoose (raw collection access), express-validator, multer, Vercel AI SDK (`ai`, `@ai-sdk/google`), bun:test against Mongo `jotihunt-test`.

Spec: `jotihunt-tracker-client/docs/superpowers/specs/2026-10-16-beheer-settings-from-env-design.md`.

## Global Constraints

- Resolution: DB → env → default. Every admin-visible value carries `source: "db" | "env" | "default"`. Clearing (null / "") a DB value falls back to env.
- Secrets never appear in any API response or log. Only `{ set, hint, source }`.
- Secret writes without a valid `SETTINGS_KEY` (base64 of 32 bytes) → 409 `{ message: "SETTINGS_KEY ontbreekt op de server.", code: "settings_key_missing" }`.
- AI slots exactly: `ocr`, `summary`, `split`, `prediction`, `chat`, `deep`, `tools`. Defaults: `gemini-3.8-flash` for ocr/summary/split/chat/tools, `gemini-pro-latest` for prediction/deep. Env fallback: ocr/summary/split ← `GEMINI_MODEL`, chat/tools ← `GEMINI_CHAT_MODEL`, prediction/deep ← `GEMINI_PREDICTION_MODEL`.
- User-facing messages in Dutch; code comments in English, matching the surrounding style.
- Tests: `npx --yes bun test <file>` (bun is not on PATH). Typecheck: `npx --yes bun x tsc --noEmit`. Mongo runs in docker on localhost:27017; never touch the live docker stack.
- Never `pkill -f`. Commit after each task; end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on a branch `feat/settings-from-env` (create from `main` before Task 1).

## File structure

| File | Responsibility |
|---|---|
| `src/settings/app-config.ts` (new) | Store, cache, resolution, encryption, change emitter, getters |
| `src/settings/app-config.test.ts` (new) | Unit tests for the above |
| `src/settings/app-config.controller.ts` (new) | Public + admin config handlers, logo upload, test-login, Traccar groups |
| `src/settings/app-config.validation.ts` (new) | express-validator chains |
| `src/routes/config.route.ts` (new) | `GET /config`, `GET /branding/logo` (public) |
| `src/routes/config.route.test.ts` (new) | HTTP tests of public + admin config routes |
| `src/services/ai/model.ts` | Rewritten: `aiModel(slot)`, `aiAvailable()` from app-config |
| `src/services/ai/model-list.ts` (new) | Fetch + filter Google model list, 10-min cache |
| `src/controllers/ai-admin.controller.ts` (new) | `GET/PUT /admin/ai/models`, `POST /admin/ai/test/:slot` |
| `src/routes/admin.route.ts` | Mount the new admin endpoints |
| `src/app.ts` | Mount `config.route` |
| `src/index.ts` | `initAppConfig`, wire listeners, update warnings |
| consumers | `hunt-ocr.*`, `prediction/*`, `article-summaries.cron.ts`, `hint-split.cron.ts`, `intel-chat/instance.ts`, `jotihunt-scraper.service.ts`, `crons/schedule.ts`, `telegram.service.ts`, `tracker-onboarding.*`, `auth/config.ts`, `auth/group-info.ts`, `intel-chat/tools/app-data.ts` |

---

### Task 1: app-config module (store, resolution, secrets, emitter)

**Files:**
- Create: `src/settings/app-config.ts`
- Test: `src/settings/app-config.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `type Source = "db" | "env" | "default"`, `interface Sourced<T> { value: T; source: Source }`
  - `AI_SLOTS`, `type AiSlot`, `VEHICLE_KEYS`, `type VehicleKey`, `SECRET_NAMES`, `type SecretName`, `PLAIN_NAMES`, `type PlainName`
  - `interface GeneralSettings`, `interface PublicConfig`, `interface AdminConfig`
  - `initAppConfig(connection: Connection, env?: Env): Promise<void>`, `resetAppConfig(): void` (tests)
  - `general<K extends keyof GeneralValues>(key: K): Sourced<GeneralValues[K]>`
  - `publicConfig(): PublicConfig`, `adminConfig(): AdminConfig`
  - `aiModelId(slot: AiSlot): Sourced<string>`
  - `secret(name: SecretName): string | null`, `plain(name: PlainName): string | null`
  - `settingsKeyOk(): boolean`
  - `setGeneral(patch: GeneralSettings, by: string | null): Promise<void>`
  - `setAiModels(patch: Partial<Record<AiSlot, string | null>>, by: string | null): Promise<void>`
  - `setSecret(name: SecretName, value: string | null, by: string | null): Promise<void>` (throws `ServiceError(409, …, { code: "settings_key_missing" })`)
  - `setPlain(patch: Partial<Record<PlainName, string | null>>, by: string | null): Promise<void>`
  - `onAppConfigChange(listener: (part: "general" | "ai" | "secrets") => void): () => void`

- [ ] **Step 1: Create the branch**

```bash
cd "/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server" && git checkout -b feat/settings-from-env
```

- [ ] **Step 2: Write the failing tests**

`src/settings/app-config.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { ServiceError } from "../http/service-error";
import {
  adminConfig,
  aiModelId,
  general,
  initAppConfig,
  onAppConfigChange,
  plain,
  publicConfig,
  resetAppConfig,
  secret,
  setAiModels,
  setGeneral,
  setPlain,
  setSecret,
  settingsKeyOk,
} from "./app-config";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
let connection: Connection;

beforeAll(async () => {
  connection = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await connection.collection("settings").deleteMany({});
  resetAppConfig();
});
afterAll(async () => {
  await connection.collection("settings").deleteMany({});
  await connection.close();
});

describe("resolution DB → env → default", () => {
  test("defaults without env or DB", async () => {
    await initAppConfig(connection, {});
    expect(general("logoUrl")).toEqual({ value: "/logo.svg", source: "default" });
    expect(general("groupName")).toEqual({ value: null, source: "default" });
    expect(general("vehicleGroups")).toEqual({ value: { walking: null, bike: null, car: null, motorcycle: null }, source: "default" });
    expect(aiModelId("ocr")).toEqual({ value: "gemini-3.8-flash", source: "default" });
    expect(aiModelId("deep")).toEqual({ value: "gemini-pro-latest", source: "default" });
    expect(secret("geminiApiKey")).toBeNull();
  });

  test("env fills in when the DB has nothing", async () => {
    await initAppConfig(connection, {
      HOME_TEAM_API_ID: "12",
      GROUP_NAME: " Wolfsheuvel ",
      HUNT_START_TIME: "2026-10-17T10:00:00+02:00",
      GROUP_CAR_ID: "3",
      GEMINI_MODEL: "flash-x",
      GEMINI_CHAT_MODEL: "chat-x",
      GEMINI_PREDICTION_MODEL: "pro-x",
      GEMINI_API_KEY: "env-key",
      TELEGRAM_BOT_USERNAME: "@Other_bot",
    });
    expect(general("homeTeamApiId")).toEqual({ value: 12, source: "env" });
    expect(general("groupName")).toEqual({ value: "Wolfsheuvel", source: "env" });
    expect(general("huntStart")).toEqual({ value: "2026-10-17T08:00:00.000Z", source: "env" });
    expect(general("vehicleGroups").value.car).toBe(3);
    expect(general("vehicleGroups").source).toBe("env");
    expect(aiModelId("split")).toEqual({ value: "flash-x", source: "env" });
    expect(aiModelId("tools")).toEqual({ value: "chat-x", source: "env" });
    expect(aiModelId("deep")).toEqual({ value: "pro-x", source: "env" });
    expect(secret("geminiApiKey")).toBe("env-key");
    expect(plain("telegramBotUsername")).toBe("Other_bot");
  });

  test("DB wins over env and survives a restart; null clears back to env", async () => {
    await initAppConfig(connection, { GROUP_NAME: "Env", GEMINI_MODEL: "flash-x" });
    await setGeneral({ groupName: "Db", vehicleGroups: { walking: 1 } }, "Sanne");
    await setAiModels({ ocr: "gemini-3.8-pro" }, "Sanne");
    expect(general("groupName")).toEqual({ value: "Db", source: "db" });
    expect(aiModelId("ocr")).toEqual({ value: "gemini-3.8-pro", source: "db" });
    expect(aiModelId("summary").source).toBe("env");
    resetAppConfig();
    await initAppConfig(connection, { GROUP_NAME: "Env" });
    expect(general("groupName").value).toBe("Db");
    expect(general("vehicleGroups").value.walking).toBe(1);
    await setGeneral({ groupName: null }, "Sanne");
    expect(general("groupName")).toEqual({ value: "Env", source: "env" });
    await setAiModels({ ocr: null }, null);
    expect(aiModelId("ocr").source).toBe("default");
  });
});

describe("secrets", () => {
  test("stored encrypted; never in the admin view; env fallback after clearing", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY, GEMINI_API_KEY: "env-key" });
    expect(settingsKeyOk()).toBe(true);
    await setSecret("geminiApiKey", "AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ", "Sanne");
    expect(secret("geminiApiKey")).toBe("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    const raw = JSON.stringify(await connection.collection("settings").findOne({ key: "app-config" }));
    expect(raw).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    const view = adminConfig();
    expect(JSON.stringify(view)).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    expect(view.secrets.geminiApiKey).toEqual({ set: true, hint: "AIza…fZ", source: "db" });
    await setSecret("geminiApiKey", null, "Sanne");
    expect(secret("geminiApiKey")).toBe("env-key");
    expect(adminConfig().secrets.geminiApiKey).toEqual({ set: true, hint: "env-…ey", source: "env" });
  });

  test("passwords get a fixed hint", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    await setSecret("jotihuntWebPassword", "geheim", null);
    expect(adminConfig().secrets.jotihuntWebPassword.hint).toBe("••••••••");
  });

  test("writing without a valid SETTINGS_KEY is a 409", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: "short" });
    expect(settingsKeyOk()).toBe(false);
    const error = await setSecret("geminiApiKey", "x", null).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ code: "settings_key_missing" });
  });

  test("a secret stored with another key reads as unset (falls back to env)", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    await setSecret("geminiApiKey", "db-key", null);
    resetAppConfig();
    await initAppConfig(connection, { SETTINGS_KEY: Buffer.alloc(32, 9).toString("base64"), GEMINI_API_KEY: "env-key" });
    expect(secret("geminiApiKey")).toBe("env-key");
  });
});

describe("plain credentials, public view and change events", () => {
  test("plain values resolve like general ones", async () => {
    await initAppConfig(connection, { JOTIHUNT_WEB_USERNAME: "env-user" });
    expect(plain("jotihuntWebUsername")).toBe("env-user");
    await setPlain({ jotihuntWebUsername: "db-user", telegramApiId: "2451873" }, null);
    expect(plain("jotihuntWebUsername")).toBe("db-user");
    expect(adminConfig().plain.telegramApiId).toEqual({ value: "2451873", source: "db" });
  });

  test("public config has no sources and no secrets", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "k", HUNT_END_TIME: "2026-10-18T12:00:00+02:00", DISCORD_URL: "https://discord.gg/x" });
    expect(publicConfig()).toEqual({
      groupName: null,
      logoUrl: "/logo.svg",
      discordUrl: "https://discord.gg/x",
      huntStart: null,
      huntEnd: "2026-10-18T10:00:00.000Z",
      homeTeamApiId: null,
      vehicleGroups: { walking: null, bike: null, car: null, motorcycle: null },
    });
  });

  test("listeners hear which part changed", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    const heard: string[] = [];
    const off = onAppConfigChange((part) => heard.push(part));
    await setGeneral({ groupName: "x" }, null);
    await setAiModels({ chat: "m" }, null);
    await setSecret("telegramApiHash", "h", null);
    await setPlain({ telegramApiId: "1" }, null);
    off();
    await setGeneral({ groupName: "y" }, null);
    expect(heard).toEqual(["general", "ai", "secrets", "secrets"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx --yes bun test src/settings/app-config.test.ts`
Expected: FAIL — `Cannot find module './app-config'`.

- [ ] **Step 4: Implement `src/settings/app-config.ts`**

```ts
import { EventEmitter } from "node:events";
import type { Connection } from "mongoose";
import { ServiceError } from "../http/service-error";
import { decryptSession, encryptSession, isValidSessionKey, type EncryptedSession } from "../services/session-crypto";

type Env = Record<string, string | undefined>;

export type Source = "db" | "env" | "default";
export interface Sourced<T> {
  value: T;
  source: Source;
}

export const AI_SLOTS = ["ocr", "summary", "split", "prediction", "chat", "deep", "tools"] as const;
export type AiSlot = (typeof AI_SLOTS)[number];
export const VEHICLE_KEYS = ["walking", "bike", "car", "motorcycle"] as const;
export type VehicleKey = (typeof VEHICLE_KEYS)[number];
export const SECRET_NAMES = ["geminiApiKey", "jotihuntWebPassword", "telegramApiHash"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const PLAIN_NAMES = ["jotihuntWebUsername", "telegramApiId", "telegramBotUsername"] as const;
export type PlainName = (typeof PLAIN_NAMES)[number];

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_PREDICTION_MODEL = "gemini-pro-latest";
export const DEFAULT_LOGO_URL = "/logo.svg";

export type VehicleGroupIds = Record<VehicleKey, number | null>;

/** Resolved general values (what the getters return) */
export interface GeneralValues {
  huntStart: string | null;
  huntEnd: string | null;
  homeTeamApiId: number | null;
  groupName: string | null;
  logoUrl: string;
  discordUrl: string | null;
  vehicleGroups: VehicleGroupIds;
}

/** What an admin may write (null or "" clears back to env/default) */
export interface GeneralSettings {
  huntStart?: string | null;
  huntEnd?: string | null;
  homeTeamApiId?: number | null;
  groupName?: string | null;
  logoUrl?: string | null;
  discordUrl?: string | null;
  vehicleGroups?: Partial<Record<VehicleKey, number | null>>;
}

export type PublicConfig = GeneralValues;

export interface SecretView {
  set: boolean;
  hint: string | null;
  source: Source;
}

export interface AdminConfig {
  general: { [K in keyof GeneralValues]: Sourced<GeneralValues[K]> };
  ai: Record<AiSlot, Sourced<string>>;
  secrets: Record<SecretName, SecretView>;
  plain: Record<PlainName, Sourced<string | null>>;
  settingsKeyOk: boolean;
}

interface StoredSecret extends EncryptedSession {
  hint: string;
}

/** The one `app-config` document in the `settings` collection of the real database */
interface AppConfigDoc {
  key: "app-config";
  general?: Omit<GeneralSettings, "vehicleGroups"> & { vehicleGroups?: Partial<Record<VehicleKey, number>> };
  ai?: { models?: Partial<Record<AiSlot, string>> };
  secrets?: { encrypted?: Partial<Record<SecretName, StoredSecret>>; plain?: Partial<Record<PlainName, string>> };
  updatedAt?: Date;
  updatedBy?: string | null;
}

const DOC_KEY = "app-config";

const VEHICLE_ENV: Record<VehicleKey, string> = { walking: "GROUP_WALKING_ID", bike: "GROUP_BIKE_ID", car: "GROUP_CAR_ID", motorcycle: "GROUP_MOTORCYCLE_ID" };
const AI_ENV: Record<AiSlot, { variable: string; fallback: string }> = {
  ocr: { variable: "GEMINI_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  summary: { variable: "GEMINI_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  split: { variable: "GEMINI_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  chat: { variable: "GEMINI_CHAT_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  tools: { variable: "GEMINI_CHAT_MODEL", fallback: DEFAULT_GEMINI_MODEL },
  prediction: { variable: "GEMINI_PREDICTION_MODEL", fallback: DEFAULT_PREDICTION_MODEL },
  deep: { variable: "GEMINI_PREDICTION_MODEL", fallback: DEFAULT_PREDICTION_MODEL },
};
const SECRET_ENV: Record<SecretName, string> = { geminiApiKey: "GEMINI_API_KEY", jotihuntWebPassword: "JOTIHUNT_WEB_PASSWORD", telegramApiHash: "TELEGRAM_API_HASH" };
const PLAIN_ENV: Record<PlainName, string> = { jotihuntWebUsername: "JOTIHUNT_WEB_USERNAME", telegramApiId: "TELEGRAM_API_ID", telegramBotUsername: "TELEGRAM_BOT_USERNAME" };
/** Secrets shown as a fixed mask instead of a start/end hint */
const MASK_ONLY: ReadonlySet<SecretName> = new Set(["jotihuntWebPassword"]);

let connection: Connection | null = null;
let env: Env = process.env;
let doc: AppConfigDoc = { key: DOC_KEY };
const events = new EventEmitter();

const text = (value: string | null | undefined) => value?.trim() || null;
const positiveInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(typeof value === "string" ? value.trim() : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const isoDate = (value: string | null | undefined): string | null => {
  const t = text(value);
  if (!t) return null;
  const date = new Date(t);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const stripAt = (value: string | null) => (value ? value.replace(/^@/, "") : null);

function pick<T>(db: T | null | undefined, fromEnv: T | null, fallback: T): Sourced<T> {
  if (db !== null && db !== undefined) return { value: db, source: "db" };
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  return { value: fallback, source: "default" };
}

export async function initAppConfig(conn: Connection, environment: Env = process.env): Promise<void> {
  connection = conn;
  env = environment;
  doc = ((await conn.collection<AppConfigDoc>("settings").findOne({ key: DOC_KEY }, { projection: { _id: 0 } })) as AppConfigDoc | null) ?? { key: DOC_KEY };
}

/** Tests only */
export function resetAppConfig() {
  connection = null;
  env = process.env;
  doc = { key: DOC_KEY };
  events.removeAllListeners();
}

export function settingsKeyOk(): boolean {
  return isValidSessionKey(env.SETTINGS_KEY?.trim() ?? "");
}

export function general<K extends keyof GeneralValues>(key: K): Sourced<GeneralValues[K]> {
  const g = doc.general ?? {};
  switch (key) {
    case "huntStart":
      return pick(isoDate(g.huntStart), isoDate(env.HUNT_START_TIME), null) as Sourced<GeneralValues[K]>;
    case "huntEnd":
      return pick(isoDate(g.huntEnd), isoDate(env.HUNT_END_TIME), null) as Sourced<GeneralValues[K]>;
    case "homeTeamApiId":
      return pick(positiveInt(g.homeTeamApiId), positiveInt(env.HOME_TEAM_API_ID), null) as Sourced<GeneralValues[K]>;
    case "groupName":
      return pick(text(g.groupName), text(env.GROUP_NAME), null) as Sourced<GeneralValues[K]>;
    case "logoUrl":
      return pick(text(g.logoUrl), text(env.LOGO_URL), DEFAULT_LOGO_URL) as Sourced<GeneralValues[K]>;
    case "discordUrl":
      return pick(text(g.discordUrl), text(env.DISCORD_URL), null) as Sourced<GeneralValues[K]>;
    case "vehicleGroups": {
      const stored = g.vehicleGroups ?? {};
      const anyDb = VEHICLE_KEYS.some((v) => positiveInt(stored[v]) !== null);
      const anyEnv = VEHICLE_KEYS.some((v) => positiveInt(env[VEHICLE_ENV[v]]) !== null);
      const value = Object.fromEntries(VEHICLE_KEYS.map((v) => [v, positiveInt(stored[v]) ?? positiveInt(env[VEHICLE_ENV[v]])])) as VehicleGroupIds;
      return { value, source: anyDb ? "db" : anyEnv ? "env" : "default" } as Sourced<GeneralValues[K]>;
    }
    default:
      throw new Error(`Unknown general setting ${String(key)}`);
  }
}

const GENERAL_KEYS = ["huntStart", "huntEnd", "homeTeamApiId", "groupName", "logoUrl", "discordUrl", "vehicleGroups"] as const satisfies readonly (keyof GeneralValues)[];

export function publicConfig(): PublicConfig {
  return Object.fromEntries(GENERAL_KEYS.map((k) => [k, general(k).value])) as unknown as PublicConfig;
}

export function aiModelId(slot: AiSlot): Sourced<string> {
  const { variable, fallback } = AI_ENV[slot];
  return pick(text(doc.ai?.models?.[slot]), text(env[variable]), fallback);
}

function dbSecret(name: SecretName): string | null {
  const stored = doc.secrets?.encrypted?.[name];
  if (!stored || !settingsKeyOk()) return null;
  try {
    return decryptSession(stored, env.SETTINGS_KEY!.trim());
  } catch {
    // Stored with another SETTINGS_KEY: treat as unset
    return null;
  }
}

export function secret(name: SecretName): string | null {
  return dbSecret(name) ?? text(env[SECRET_ENV[name]]);
}

function hintFor(name: SecretName, value: string): string {
  if (MASK_ONLY.has(name) || value.length < 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function secretView(name: SecretName): SecretView {
  const db = dbSecret(name);
  if (db !== null) return { set: true, hint: doc.secrets!.encrypted![name]!.hint, source: "db" };
  const fromEnv = text(env[SECRET_ENV[name]]);
  if (fromEnv !== null) return { set: true, hint: hintFor(name, fromEnv), source: "env" };
  return { set: false, hint: null, source: "default" };
}

function plainSourced(name: PlainName): Sourced<string | null> {
  const resolved = pick(text(doc.secrets?.plain?.[name]), text(env[PLAIN_ENV[name]]), null);
  return name === "telegramBotUsername" ? { ...resolved, value: stripAt(resolved.value) } : resolved;
}

export function plain(name: PlainName): string | null {
  return plainSourced(name).value;
}

export function adminConfig(): AdminConfig {
  return {
    general: Object.fromEntries(GENERAL_KEYS.map((k) => [k, general(k)])) as AdminConfig["general"],
    ai: Object.fromEntries(AI_SLOTS.map((slot) => [slot, aiModelId(slot)])) as AdminConfig["ai"],
    secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, secretView(name)])) as AdminConfig["secrets"],
    plain: Object.fromEntries(PLAIN_NAMES.map((name) => [name, plainSourced(name)])) as AdminConfig["plain"],
    settingsKeyOk: settingsKeyOk(),
  };
}

/** Persist first, then update the cache (a failed write leaves both unchanged), then tell the listeners. */
async function write(set: Record<string, unknown>, unset: string[], by: string | null, part: "general" | "ai" | "secrets") {
  if (!connection) throw new Error("App config is not initialised");
  const settings = connection.collection<AppConfigDoc>("settings");
  const update: Record<string, unknown> = { $set: { ...set, key: DOC_KEY, updatedAt: new Date(), updatedBy: by } };
  if (unset.length) update.$unset = Object.fromEntries(unset.map((path) => [path, ""]));
  await settings.updateOne({ key: DOC_KEY }, update, { upsert: true });
  doc = ((await settings.findOne({ key: DOC_KEY }, { projection: { _id: 0 } })) as AppConfigDoc | null) ?? { key: DOC_KEY };
  events.emit("change", part);
}

export async function setGeneral(patch: GeneralSettings, by: string | null): Promise<void> {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const put = (path: string, value: unknown) => (value === null || value === undefined || value === "" ? unset.push(path) : (set[path] = value));
  for (const key of ["huntStart", "huntEnd"] as const) if (key in patch) put(`general.${key}`, isoDate(patch[key]));
  if ("homeTeamApiId" in patch) put("general.homeTeamApiId", positiveInt(patch.homeTeamApiId));
  for (const key of ["groupName", "logoUrl", "discordUrl"] as const) if (key in patch) put(`general.${key}`, text(patch[key]));
  for (const vehicle of VEHICLE_KEYS) if (patch.vehicleGroups && vehicle in patch.vehicleGroups) put(`general.vehicleGroups.${vehicle}`, positiveInt(patch.vehicleGroups[vehicle]));
  await write(set, unset, by, "general");
}

export async function setAiModels(patch: Partial<Record<AiSlot, string | null>>, by: string | null): Promise<void> {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const slot of AI_SLOTS) {
    if (!(slot in patch)) continue;
    const id = text(patch[slot]);
    if (id) set[`ai.models.${slot}`] = id;
    else unset.push(`ai.models.${slot}`);
  }
  await write(set, unset, by, "ai");
}

export async function setSecret(name: SecretName, value: string | null, by: string | null): Promise<void> {
  const plainValue = text(value);
  if (plainValue === null) return write({}, [`secrets.encrypted.${name}`], by, "secrets");
  if (!settingsKeyOk()) throw new ServiceError(409, "SETTINGS_KEY ontbreekt op de server.", { code: "settings_key_missing" });
  const stored: StoredSecret = { ...encryptSession(plainValue, env.SETTINGS_KEY!.trim()), hint: hintFor(name, plainValue) };
  await write({ [`secrets.encrypted.${name}`]: stored }, [], by, "secrets");
}

export async function setPlain(patch: Partial<Record<PlainName, string | null>>, by: string | null): Promise<void> {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const name of PLAIN_NAMES) {
    if (!(name in patch)) continue;
    const value = name === "telegramBotUsername" ? stripAt(text(patch[name])) : text(patch[name]);
    if (value) set[`secrets.plain.${name}`] = value;
    else unset.push(`secrets.plain.${name}`);
  }
  await write(set, unset, by, "secrets");
}

export function onAppConfigChange(listener: (part: "general" | "ai" | "secrets") => void): () => void {
  events.on("change", listener);
  return () => events.off("change", listener);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --yes bun test src/settings/app-config.test.ts`
Expected: PASS (all tests). Then `npx --yes bun x tsc --noEmit` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/settings/app-config.ts src/settings/app-config.test.ts
git commit -m "feat(settings): app config store with env fallback and encrypted secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Boot wiring + general getters replace env reads

**Files:**
- Modify: `src/index.ts` (after `await initHuntableAreas(getDemoStateStore());`)
- Modify: `src/auth/config.ts:29-33` (`groupConfig`)
- Modify: `src/services/tracker-onboarding.helpers.ts:74-82`, `src/services/tracker-onboarding.instance.ts`
- Test: `src/settings/app-config.test.ts` (add), `src/services/tracker-onboarding.helpers.test.ts` (if it tests `vehicleGroupsFromEnv`, update)

**Interfaces:**
- Consumes: `initAppConfig`, `general`, `onAppConfigChange`, `VehicleGroupIds` from Task 1.
- Produces: `groupConfig(): { homeTeamApiId: number | null; groupName: string | null }` (same shape, no env arg); `vehicleGroups` (same exported mutable object, kept in sync); `syncVehicleGroups(target: VehicleGroups): void` in `tracker-onboarding.helpers.ts`.

- [ ] **Step 1: Write the failing test** (append to `src/settings/app-config.test.ts`)

```ts
import { syncVehicleGroups, type VehicleGroups } from "../services/tracker-onboarding.helpers";

describe("vehicle groups sync", () => {
  test("the shared object follows the config, dropping cleared vehicles", async () => {
    await initAppConfig(connection, { GROUP_CAR_ID: "3" });
    const shared = { walking: 9 } as VehicleGroups;
    syncVehicleGroups(shared);
    expect(shared).toEqual({ car: 3 });
    await setGeneral({ vehicleGroups: { walking: 1, car: null } }, null);
    syncVehicleGroups(shared);
    expect(shared).toEqual({ walking: 1, car: 3 });
  });
});
```

(`car: null` clears the DB value, so the env value 3 shows again.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx --yes bun test src/settings/app-config.test.ts`
Expected: FAIL — `syncVehicleGroups` is not exported.

- [ ] **Step 3: Implement**

`src/services/tracker-onboarding.helpers.ts` — replace `parseGroupId` + `vehicleGroupsFromEnv` with:

```ts
import { general } from "../settings/app-config";

/**
 * Copy the configured Traccar group id per vehicle (Beheer, else GROUP_*_ID) into `target`. The onboarding service
 * and the tracker controller share one object, so syncing it in place updates them all.
 */
export function syncVehicleGroups(target: VehicleGroups): void {
  const ids = general("vehicleGroups").value;
  for (const vehicle of VEHICLES) {
    const id = ids[vehicle];
    if (id) target[vehicle] = id;
    else delete target[vehicle];
  }
}
```

Run `grep -rn "vehicleGroupsFromEnv" src` and replace every remaining use (tests included) with an object literal or `syncVehicleGroups`.

`src/services/tracker-onboarding.instance.ts`:

```ts
import { onAppConfigChange } from "../settings/app-config";
import { syncVehicleGroups, type VehicleGroups } from "./tracker-onboarding.helpers";

/** Vehicle → Traccar group ids (Beheer, else env); one shared object, synced in place when the config changes. */
export const vehicleGroups = {} as VehicleGroups;
syncVehicleGroups(vehicleGroups);
onAppConfigChange((part) => part === "general" && syncVehicleGroups(vehicleGroups));
```

(Keep the `onboarding` export unchanged. `VehicleGroups` is `Record<Vehicle, number | undefined>` in the helpers.) Because this module loads before `initAppConfig` runs, also call `syncVehicleGroups(vehicleGroups)` once in `src/index.ts` after `initAppConfig` (Step 4).

`src/auth/config.ts` — replace `groupConfig`:

```ts
import { general } from "../settings/app-config";

/** The own group (Beheer → Algemeen, else HOME_TEAM_API_ID / GROUP_NAME). */
export function groupConfig(): { homeTeamApiId: number | null; groupName: string | null } {
  return { homeTeamApiId: general("homeTeamApiId").value, groupName: general("groupName").value };
}
```

Update any test that called `groupConfig(env)` with an env object to set the config via `initAppConfig(connection, env)` instead (`grep -rn "groupConfig(" src`).

- [ ] **Step 4: Wire boot in `src/index.ts`** — after `await initHuntableAreas(getDemoStateStore());`:

```ts
// Settings moved from env to Beheer (env stays the fallback); secrets need SETTINGS_KEY
await initAppConfig(getDemoStateStore().connection);
syncVehicleGroups(vehicleGroups);
if (!settingsKeyOk()) logger.warn("SETTINGS_KEY is missing or not 32 bytes (base64): keys and passwords can't be saved in Beheer. Generate one with: openssl rand -base64 32");
```

with imports `import { initAppConfig, settingsKeyOk } from "./settings/app-config";`, `import { syncVehicleGroups } from "./services/tracker-onboarding.helpers";`, `import { vehicleGroups } from "./services/tracker-onboarding.instance";`.

- [ ] **Step 5: Run tests**

Run: `npx --yes bun test src/settings src/services/tracker-onboarding* src/auth src/routes/pairing.route.test.ts` then `npx --yes bun x tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(settings): group and vehicle groups come from the app config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Public `/config`, admin config routes, logo upload, Traccar groups, invite group info

**Files:**
- Create: `src/settings/app-config.validation.ts`, `src/settings/app-config.controller.ts`, `src/routes/config.route.ts`, `src/routes/config.route.test.ts`
- Modify: `src/routes/admin.route.ts`, `src/app.ts`, `src/auth/group-info.ts`

**Interfaces:**
- Consumes: Task 1 getters/setters; `getGroups()` from `src/services/traccar.service.ts` (returns `TraccarGroup[]` with `id`, `name`); `isTraccarConfigured`.
- Produces HTTP:
  - `GET /config` (public) → `PublicConfig`
  - `GET /branding/logo` (public) → the uploaded logo file, 404 when none
  - `GET /admin/config` → `AdminConfig`
  - `PUT /admin/config/general` body `GeneralSettings` → `AdminConfig`
  - `PUT /admin/config/secrets/:name` body `{ value: string }` → `AdminConfig`; `DELETE /admin/config/secrets/:name` → `AdminConfig`
  - `PUT /admin/config/plain` body `Partial<Record<PlainName, string|null>>` → `AdminConfig`
  - `POST /admin/config/logo` multipart `logo` → `AdminConfig` (sets `logoUrl` to `/branding/logo?v=<timestamp>`: a path on the API, the client prefixes its API base URL)
  - `GET /admin/traccar/groups` → `{ id: number; name: string }[]` (503 when Traccar isn't configured)

- [ ] **Step 1: Write the failing tests** — `src/routes/config.route.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose, { type Connection } from "mongoose";
import { User } from "../models/user.model";
import { initAppConfig, resetAppConfig } from "../settings/app-config";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const uploads = mkdtempSync(path.join(tmpdir(), "config-route-"));
process.env.UPLOADS_DIR = uploads;
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let server: Server;
let base: string;
let db: Connection;
let admin: { _id: unknown };
let member: { _id: unknown };

beforeAll(async () => {
  await connectTestDb();
  db = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await db.collection("settings").deleteMany({});
  resetAppConfig();
  await initAppConfig(db, { SETTINGS_KEY: KEY, GROUP_NAME: "Env-groep" });
  admin = await withSession(await User.create({ name: "Admin", admin: true }));
  member = await withSession(await User.create({ name: "Lid", admin: false }));
});
afterAll(async () => {
  server.close();
  await db.collection("settings").deleteMany({});
  await db.close();
  await disconnectTestDb();
  rmSync(uploads, { recursive: true, force: true });
});

const as = (user: { _id: unknown }, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tokenFor(user)}` } });
const json = (user: { _id: unknown }, method: string, body: unknown) => as(user, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("GET /config", () => {
  test("public, no login needed", async () => {
    const res = await fetch(`${base}/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupName: "Env-groep", logoUrl: "/logo.svg" });
  });
});

describe("admin config", () => {
  test("members get 403", async () => {
    expect((await fetch(`${base}/admin/config`, as(member))).status).toBe(403);
  });

  test("PUT general saves and shows source db; validation errors are Dutch 400s", async () => {
    const ok = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { groupName: "Wolfsheuvel", huntStart: "2026-10-17T09:00:00+02:00", huntEnd: "2026-10-18T15:00:00+02:00", vehicleGroups: { car: 3 } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.general.groupName).toEqual({ value: "Wolfsheuvel", source: "db" });
    expect(body.general.vehicleGroups.value.car).toBe(3);
    const bad = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { huntStart: "2026-10-18T10:00:00Z", huntEnd: "2026-10-17T10:00:00Z" }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("Einde moet na de start liggen.");
    const badUrl = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { discordUrl: "javascript:alert(1)" }));
    expect(badUrl.status).toBe(400);
  });

  test("secrets: saved, never echoed, cleared", async () => {
    const put = await fetch(`${base}/admin/config/secrets/geminiApiKey`, json(admin, "PUT", { value: "AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ" }));
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    expect(JSON.parse(text).secrets.geminiApiKey).toEqual({ set: true, hint: "AIza…fZ", source: "db" });
    expect((await fetch(`${base}/admin/config/secrets/nope`, json(admin, "PUT", { value: "x" }))).status).toBe(400);
    const del = await fetch(`${base}/admin/config/secrets/geminiApiKey`, as(admin, { method: "DELETE" }));
    expect((await del.json()).secrets.geminiApiKey.set).toBe(false);
  });

  test("logo upload is served publicly and sets logoUrl", async () => {
    const form = new FormData();
    form.append("logo", new Blob([PNG], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/admin/config/logo`, as(admin, { method: "POST", body: form }));
    expect(res.status).toBe(200);
    expect((await res.json()).general.logoUrl.value).toStartWith("/branding/logo?v=");
    const logo = await fetch(`${base}/branding/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/png");
  });

  test("logo upload rejects non-images", async () => {
    const form = new FormData();
    form.append("logo", new Blob([Buffer.from("hello")], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/admin/config/logo`, as(admin, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("Kies een PNG-, JPG-, WebP- of SVG-afbeelding.");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx --yes bun test src/routes/config.route.test.ts`
Expected: FAIL — 404s / module not found.

- [ ] **Step 3: Validation** — `src/settings/app-config.validation.ts`

```ts
import { body, param } from "express-validator";
import { PLAIN_NAMES, SECRET_NAMES, VEHICLE_KEYS } from "./app-config";

const optionalNullable = { values: "null" as const };
/** http(s) URL or a site path; never javascript: etc. */
const isSafeUrl = (value: string) => value === "" || value.startsWith("/") || /^https?:\/\/[^\s]+$/i.test(value);

export const generalValidation = [
  body("huntStart").optional(optionalNullable).isISO8601().withMessage("Start is geen geldige datum."),
  body("huntEnd")
    .optional(optionalNullable)
    .isISO8601()
    .withMessage("Einde is geen geldige datum.")
    .bail()
    .custom((end, { req }) => !req.body.huntStart || new Date(end) > new Date(req.body.huntStart))
    .withMessage("Einde moet na de start liggen."),
  body("homeTeamApiId").optional(optionalNullable).isInt({ min: 1 }).withMessage("Kies een team."),
  body("groupName").optional(optionalNullable).isString().trim().isLength({ max: 60 }).withMessage("Groepsnaam is maximaal 60 tekens."),
  body("logoUrl").optional(optionalNullable).isString().trim().custom(isSafeUrl).withMessage("Logo moet een http(s)-link of /pad zijn."),
  body("discordUrl").optional(optionalNullable).isString().trim().custom(isSafeUrl).withMessage("Discord-link moet met https:// beginnen."),
  body("vehicleGroups").optional().isObject().withMessage("Voertuiggroepen zijn ongeldig."),
  ...VEHICLE_KEYS.map((vehicle) => body(`vehicleGroups.${vehicle}`).optional(optionalNullable).isInt({ min: 1 }).withMessage("Kies een Traccar-groep.")),
];

export const secretValidation = [
  param("name").isIn(SECRET_NAMES).withMessage("Onbekende instelling."),
  body("value").isString().trim().isLength({ min: 1, max: 500 }).withMessage("Vul een waarde in."),
];

export const secretNameValidation = [param("name").isIn(SECRET_NAMES).withMessage("Onbekende instelling.")];

export const plainValidation = [
  body().custom((value) => Object.keys(value ?? {}).every((key) => (PLAIN_NAMES as readonly string[]).includes(key))).withMessage("Onbekende instelling."),
  body("telegramApiId").optional(optionalNullable).isInt({ min: 1 }).withMessage("API ID is een getal."),
  body("jotihuntWebUsername").optional(optionalNullable).isString().trim().isLength({ max: 200 }),
  body("telegramBotUsername").optional(optionalNullable).isString().trim().matches(/^@?[A-Za-z0-9_]{3,64}$/).withMessage("Ongeldige botnaam."),
];
```

- [ ] **Step 4: Controller** — `src/settings/app-config.controller.ts`

```ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { respond, ServiceError } from "../http/service-error";
import { logger } from "../logger";
import { detectPhotoType } from "../middleware/photo-upload.middleware";
import * as traccarService from "../services/traccar.service";
import { adminConfig, publicConfig, setGeneral, setPlain, setSecret, type SecretName } from "./app-config";

const by = (req: Request) => req.user?.name ?? null;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

/** Uploaded branding lives next to the hunt photos (real uploads dir, never the demo one). */
function brandingDir(): string {
  return path.join(path.resolve(process.env.UPLOADS_DIR || "uploads"), "branding");
}

export function getPublicConfig(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).json(publicConfig());
}

export function getAdminConfig(_req: Request, res: Response) {
  return res.status(200).json(adminConfig());
}

export async function putGeneral(req: Request, res: Response) {
  await setGeneral(req.body, by(req));
  logger.info(`General settings changed by ${by(req)}: ${Object.keys(req.body).join(", ")}`);
  return res.status(200).json(adminConfig());
}

export async function putSecret(req: Request, res: Response) {
  const name = req.params.name as SecretName;
  return respond(res, 200, async () => {
    await setSecret(name, String(req.body.value), by(req));
    logger.info(`Secret ${name} changed by ${by(req)}`);
    return adminConfig();
  });
}

export async function deleteSecret(req: Request, res: Response) {
  const name = req.params.name as SecretName;
  await setSecret(name, null, by(req));
  logger.info(`Secret ${name} cleared by ${by(req)}`);
  return res.status(200).json(adminConfig());
}

export async function putPlain(req: Request, res: Response) {
  await setPlain(req.body, by(req));
  return res.status(200).json(adminConfig());
}

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }).single("logo");

/** The real type of the bytes (the declared type can't be trusted); SVG by its opening tag. */
function logoType(buffer: Buffer): string | null {
  const photo = detectPhotoType(buffer);
  if (photo) return photo;
  const head = buffer.subarray(0, 512).toString("utf8").trimStart();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) ? "image/svg+xml" : null;
}

export function parseLogo(req: Request, res: Response, next: NextFunction) {
  logoUpload(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? "Logo is groter dan 1 MB." : "Logo uploaden is mislukt." });
    if (error) return next(error);
    next();
  });
}

export async function postLogo(req: Request, res: Response) {
  const file = req.file;
  const type = file ? logoType(file.buffer) : null;
  if (!file || !type) return res.status(400).json({ message: "Kies een PNG-, JPG-, WebP- of SVG-afbeelding." });
  const dir = brandingDir();
  await mkdir(dir, { recursive: true });
  for (const old of await readdir(dir)) if (old.startsWith("logo.")) await rm(path.join(dir, old), { force: true });
  await writeFile(path.join(dir, `logo.${LOGO_TYPES[type]}`), file.buffer);
  // A path on the API (the client prefixes API_BASE_URL); ?v= busts caches after a new upload
  await setGeneral({ logoUrl: `/branding/logo?v=${Date.now()}` }, by(req));
  logger.info(`Logo uploaded by ${by(req)}`);
  return res.status(200).json(adminConfig());
}

export async function getLogo(_req: Request, res: Response) {
  const dir = brandingDir();
  const file = (await readdir(dir).catch(() => [] as string[])).find((name) => name.startsWith("logo."));
  if (!file) return res.status(404).json({ message: "Geen logo geüpload." });
  const ext = file.split(".").pop()!;
  const type = Object.entries(LOGO_TYPES).find(([, e]) => e === ext)![0];
  res.setHeader("Content-Type", type);
  // SVG may hold scripts: never run them in our origin
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(await readFile(path.join(dir, file)));
}

export async function getTraccarGroups(_req: Request, res: Response) {
  return respond(res, 200, async () => {
    if (!traccarService.isTraccarConfigured) throw new ServiceError(503, "Traccar is niet ingesteld op de server.");
    const groups = await traccarService.getGroups();
    return groups.map((group) => ({ id: group.id, name: group.name })).sort((a, b) => a.id - b.id);
  });
}
```

- [ ] **Step 5: Routes**

`src/routes/config.route.ts`:

```ts
import express from "express";
import * as configController from "../settings/app-config.controller";

const router = express.Router();
// Public: the invite and login pages need the group name and logo before anyone is signed in
router.get("/config", configController.getPublicConfig);
router.get("/branding/logo", configController.getLogo);

export default router;
```

In `src/app.ts`, import `configRoute from "./routes/config.route"` and mount it right after `app.use("/invites", invitesRoute);` (after the demo gate, like the other public auth routes): `app.use(configRoute);`.

In `src/routes/admin.route.ts` (after the existing routes, below `router.use(verifyToken, isAdmin)`):

```ts
import * as configController from "../settings/app-config.controller";
import { generalValidation, plainValidation, secretNameValidation, secretValidation } from "../settings/app-config.validation";

// Settings that used to be env vars (Beheer → Algemeen / AI / Koppelingen)
router.get("/config", configController.getAdminConfig);
router.put("/config/general", validate(generalValidation), configController.putGeneral);
router.put("/config/plain", validate(plainValidation), configController.putPlain);
router.put("/config/secrets/:name", validate(secretValidation), configController.putSecret);
router.delete("/config/secrets/:name", validate(secretNameValidation), configController.deleteSecret);
router.post("/config/logo", configController.parseLogo, configController.postLogo);
router.get("/traccar/groups", configController.getTraccarGroups);
```

- [ ] **Step 6: Invite page group info** — `src/auth/group-info.ts`:

```ts
import { Team } from "../models/team.model";
import { general } from "../settings/app-config";
import { groupConfig } from "./config";

/** The own group for the invite page: the configured name and logo first, else the home team's, else the app name. */
export async function groupInfo(): Promise<{ name: string; logoUrl: string | null }> {
  const { homeTeamApiId, groupName } = groupConfig();
  const logo = general("logoUrl");
  const team = homeTeamApiId ? await Team.findOne({ apiId: homeTeamApiId }, { name: 1, logoUrl: 1 }).lean() : null;
  return { name: groupName ?? team?.name ?? "Jotihunt Tracker", logoUrl: logo.source !== "default" ? logo.value : (team?.logoUrl ?? null) };
}
```

Run `npx --yes bun test src/auth` and fix any invite test whose expectation relied on team name winning over `GROUP_NAME` (the configured name now wins: an admin who types a name wants to see it).

- [ ] **Step 7: Run tests**

Run: `npx --yes bun test src/routes/config.route.test.ts src/auth && npx --yes bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(settings): public /config, admin config routes, logo upload, Traccar groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gemini models read from the app config at use time

**Files:**
- Modify: `src/services/ai/model.ts` (rewrite), `src/services/ai/model.test.ts` (rewrite)
- Modify: `src/services/hunt-ocr.service.ts:12-16,109-126`, `src/services/hunt-ocr.instance.ts`, `src/services/hunt-ocr.service.test.ts` (5 `reader` uses)
- Modify: `src/services/prediction/prediction.service.ts:14-15,123-129`, `src/services/prediction/instance.ts`, `src/services/prediction/prediction.service.test.ts` (5 `predictor` uses)
- Modify: `src/crons/article-summaries.cron.ts`, `src/crons/hint-split.cron.ts`, `src/services/intel-chat/instance.ts`
- Modify: `src/index.ts:155-157` (GEMINI warning)

**Interfaces:**
- Consumes: `secret("geminiApiKey")`, `aiModelId(slot)`, `AiSlot`, `DEFAULT_GEMINI_MODEL`, `DEFAULT_PREDICTION_MODEL` (Task 1).
- Produces: `aiAvailable(): boolean`; `aiModel(slot: AiSlot): LanguageModel | null`; `requireAiModel(slot: AiSlot): LanguageModel` (throws `GeminiError(NO_KEY_MESSAGE, false)`); `NO_KEY_MESSAGE = "Geen Gemini-sleutel ingesteld"`; `setAiBaseUrl(url: string | undefined)` (tests). Re-export `DEFAULT_GEMINI_MODEL`, `DEFAULT_PREDICTION_MODEL`, `type AiSlot as AiPurpose`.
- `HuntOcrDeps.reader` becomes `() => StickerReader | null`; `PredictionServiceDeps.predictor` becomes `() => FoxPredictor | null`.

- [ ] **Step 1: Rewrite the failing test** — `src/services/ai/model.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { initAppConfig, resetAppConfig, setAiModels, setSecret } from "../../settings/app-config";
import { aiAvailable, aiModel, DEFAULT_GEMINI_MODEL, DEFAULT_PREDICTION_MODEL, requireAiModel } from "./model";
import { GeminiError } from "./gemini-error";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const id = (model: unknown) => (model as { modelId: string }).modelId;
let connection: Connection;

beforeAll(async () => {
  connection = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await connection.collection("settings").deleteMany({});
  resetAppConfig();
});
afterAll(async () => {
  await connection.close();
});

describe("aiModel", () => {
  test("defaults", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(DEFAULT_PREDICTION_MODEL).toBe("gemini-pro-latest");
  });

  test("no key means no models; requireAiModel throws a GeminiError", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "  " });
    expect(aiAvailable()).toBe(false);
    expect(aiModel("ocr")).toBeNull();
    expect(() => requireAiModel("ocr")).toThrow(GeminiError);
  });

  test("each slot gets its model; a key or model saved in Beheer applies at once", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "k", SETTINGS_KEY: KEY });
    expect(id(aiModel("split"))).toBe("gemini-3.8-flash");
    expect(id(aiModel("deep"))).toBe("gemini-pro-latest");
    await setAiModels({ split: "gemini-3.8-flash-lite" }, null);
    expect(id(aiModel("split"))).toBe("gemini-3.8-flash-lite");
    await setSecret("geminiApiKey", "other", null);
    expect(aiAvailable()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx --yes bun test src/services/ai/model.test.ts`
Expected: FAIL — `aiModel` not exported.

- [ ] **Step 3: Rewrite `src/services/ai/model.ts`**

```ts
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { aiModelId, secret, type AiSlot } from "../../settings/app-config";
import { GeminiError } from "./gemini-error";

export { DEFAULT_GEMINI_MODEL, DEFAULT_PREDICTION_MODEL } from "../../settings/app-config";
/** What a Gemini call is for; each has its own model in Beheer → AI */
export type AiPurpose = AiSlot;

export const NO_KEY_MESSAGE = "Geen Gemini-sleutel ingesteld";

let provider: { apiKey: string; baseURL: string | undefined; google: GoogleGenerativeAIProvider } | null = null;
let baseURLOverride: string | undefined;

/** Tests only: a local server in place of Google */
export function setAiBaseUrl(url: string | undefined) {
  baseURLOverride = url;
  provider = null;
}

/** True when a Gemini key is set (Beheer, else GEMINI_API_KEY) */
export function aiAvailable(): boolean {
  return secret("geminiApiKey") !== null;
}

/** The model for `slot`, read now (a key or model changed in Beheer applies to the next call); null without a key. */
export function aiModel(slot: AiSlot): LanguageModel | null {
  const apiKey = secret("geminiApiKey");
  if (!apiKey) return null;
  if (!provider || provider.apiKey !== apiKey || provider.baseURL !== baseURLOverride) {
    provider = { apiKey, baseURL: baseURLOverride, google: createGoogleGenerativeAI({ apiKey, baseURL: baseURLOverride }) };
  }
  return provider.google(aiModelId(slot).value);
}

/** Like aiModel, but a missing key is a (non-retryable) GeminiError, as for any other failed call */
export function requireAiModel(slot: AiSlot): LanguageModel {
  const model = aiModel(slot);
  if (!model) throw new GeminiError(NO_KEY_MESSAGE, false);
  return model;
}
```

(`GoogleGenerativeAIProvider` is exported by `@ai-sdk/google` as an alias of `GoogleProvider`.)

- [ ] **Step 4: OCR reads the model per reading**

`src/services/hunt-ocr.service.ts`: change the dep to a getter and use it:

```ts
export const NO_KEY_ERROR = "Geen Gemini-sleutel ingesteld";
// in the deps interface:
  /** The reader right now; null without a Gemini key: every reading then fails with NO_KEY_ERROR */
  reader: () => StickerReader | null;
// in attempt():
    const reader = deps.reader();
    if (!reader) {
      await fail(id, generation, NO_KEY_ERROR);
      return null;
    }
// … and further down use `reader.readSticker(...)` instead of `deps.reader.readSticker(...)`
```

`src/services/hunt-ocr.instance.ts`: delete `const models = createModels();` and the `createModels` import; import `{ aiModel } from "./ai/model"`; set:

```ts
  reader: () => {
    const model = aiModel("ocr");
    return model ? createGeminiClient({ model }) : null;
  },
```

`src/services/hunt-ocr.service.test.ts`: in `setup(reader)` pass `reader: () => reader`; leave the other `reader` constants as they are (they are objects handed to `setup`). Run `grep -n "createHuntOcr(" src/services/hunt-ocr.service.test.ts` and wrap any other direct `reader:` the same way.

- [ ] **Step 5: Prediction reads the model per run**

`src/services/prediction/prediction.service.ts`:

```ts
  /** The predictor right now; null without a Gemini key */
  predictor: () => FoxPredictor | null;
// at line ~123:
    const predictor = deps.predictor();
    if (!predictor) return store({ ...dto, reason: "AI niet geconfigureerd" });
// at line ~129: askGemini(predictor, …)
```

`src/services/prediction/instance.ts`:

```ts
import { aiModel } from "../ai/model";
// remove `const models = createModels();`
export const predictionService = createPredictionService({
  predictor: () => {
    const model = aiModel("prediction");
    return model ? createGeminiPredictor({ model }) : null;
  },
  walkMinutes,
});
```

`src/services/prediction/prediction.service.test.ts`: `serviceAt` passes `predictor: () => predictor`; wrap any other direct `predictor:` in `createPredictionService(...)` the same way.

- [ ] **Step 6: Crons and chat**

`src/crons/article-summaries.cron.ts` — replace the `models`/`job` block:

```ts
import { aiAvailable, requireAiModel } from "../services/ai/model";

// Built once (the job keeps its backoff); the model is read per article, so a key or model set in Beheer applies at once
const job = createSummaryJob({
  summarizer: { summarize: (article) => createArticleSummarizer({ model: requireAiModel("summary") }).summarize(article) },
  beginRun: () => {
    const generation = currentGeneration();
    return (fn) => runTracked(fn, { generation });
  },
});
```

and in `summarizeArticles()`: `if (!aiAvailable()) return;` instead of `if (!job) return;`. Update the comment above (no GEMINI_API_KEY → "without a Gemini key").

`src/crons/hint-split.cron.ts` — same shape, slot `"split"`:

```ts
const job = createHintSplitJob({
  splitter: { split: (article, areas) => createHintSplitter({ model: requireAiModel("split") }).split(article, areas) },
  beginRun: () => {
    const generation = currentGeneration();
    return (fn) => runTracked(fn, { generation });
  },
});
```

and `if (!aiAvailable()) return;` in `splitHints()`.

`src/services/intel-chat/instance.ts`:

```ts
import { aiAvailable, requireAiModel } from "../ai/model";

/** Tests: fixed models (null = AI off); undefined = from the app config */
let override: IntelChatModels | null | undefined;

/** The chat's models, read per request (Beheer → AI); null without a Gemini key */
export function getIntelChatModels(): IntelChatModels | null {
  if (override !== undefined) return override;
  if (!aiAvailable()) return null;
  return { chat: requireAiModel("chat"), deep: requireAiModel("deep"), tool: requireAiModel("tools") };
}

export function setIntelChatModels(value: IntelChatModels | null | undefined) {
  override = value;
}
```

(Keep `toolDeps` / `getIntelToolDeps` unchanged.)

`src/index.ts` — replace the `GEMINI_API_KEY not set` warning condition with `if (!aiAvailable())` and message `"No Gemini key (Beheer → AI or GEMINI_API_KEY): hunt photos are not read, fox predictions are off, articles get no summary and hints are split by rule only"`; import `aiAvailable` from `./services/ai/model`.

- [ ] **Step 7: Run tests**

Run: `grep -rn "createModels" src` → no hits. Then `npx --yes bun test src/services src/crons src/controllers src/routes/intel-chat.route.test.ts && npx --yes bun x tsc --noEmit`
Expected: PASS. Tests that set `GEMINI_API_KEY` in `process.env` before importing a module now need the app config: call `initAppConfig(connection, { GEMINI_API_KEY: "k" })` in their `beforeAll` (find them with `grep -rln "GEMINI_API_KEY" src --include=*.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(ai): models and key read from Beheer at use time, own slots for split, deep and tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: AI admin — model list, model choice, test call

**Files:**
- Create: `src/services/ai/model-list.ts`, `src/services/ai/model-list.test.ts`, `src/controllers/ai-admin.controller.ts`
- Modify: `src/routes/admin.route.ts`
- Test: `src/routes/config.route.test.ts` (add a describe)

**Interfaces:**
- Consumes: `secret`, `setAiModels`, `adminConfig`, `AI_SLOTS`, `AiSlot` (Task 1); `requireAiModel`, `aiModel` (Task 4); `toGeminiError` from `src/services/ai/gemini-error.ts`.
- Produces:
  - `interface GeminiModelInfo { id: string; displayName: string; group: "alias" | "latest" | "older" }`
  - `filterGeminiModels(raw: RawModel[]): GeminiModelInfo[]`
  - `listGeminiModels(options?: { refresh?: boolean; fetchImpl?: typeof fetch; baseUrl?: string }): Promise<{ models: GeminiModelInfo[]; fetchedAt: string }>` (throws `ServiceError(400, "Google weigert de Gemini-sleutel.")` on 400/403, `ServiceError(502, "Modellijst van Google niet bereikbaar.")` otherwise, `ServiceError(409, "Geen Gemini-sleutel ingesteld.")` without key)
  - HTTP: `GET /admin/ai/models[?refresh=1]` → `{ models, fetchedAt }`; `PUT /admin/ai/models` body `{ models: Partial<Record<AiSlot, string | null>> }` → `AdminConfig`; `POST /admin/ai/test/:slot` → `{ ok: true, ms: number } | { ok: false, error: string }`

- [ ] **Step 1: Write the failing filter test** — `src/services/ai/model-list.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { filterGeminiModels } from "./model-list";

const raw = (name: string, methods = ["generateContent"], displayName = name) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });

describe("filterGeminiModels", () => {
  test("keeps Gemini text models, groups aliases / newest version / older", () => {
    const models = filterGeminiModels([
      raw("gemini-3.5-flash"),
      raw("gemini-3.8-pro"),
      raw("gemini-flash-latest"),
      raw("gemini-3.8-flash"),
      raw("gemini-embedding-001", ["embedContent"]),
      raw("gemini-3.8-flash-image"),
      raw("gemini-3.8-flash-preview-tts"),
      raw("gemini-live-3.8-flash"),
      raw("imagen-4.0-generate"),
      raw("gemma-3-27b-it"),
      raw("aqa", ["generateAnswer"]),
    ]);
    expect(models.map((m) => [m.id, m.group])).toEqual([
      ["gemini-flash-latest", "alias"],
      ["gemini-3.8-flash", "latest"],
      ["gemini-3.8-pro", "latest"],
      ["gemini-3.5-flash", "older"],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx --yes bun test src/services/ai/model-list.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/services/ai/model-list.ts`**

```ts
import { ServiceError } from "../../http/service-error";
import { secret } from "../../settings/app-config";

export interface RawModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  group: "alias" | "latest" | "older";
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CACHE_MS = 10 * 60 * 1000;
/** Not for text: embeddings, image/audio generation, live/TTS */
const NOT_TEXT = /embedding|imagen|tts|image|live|audio/;

const versionOf = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? NaN);

/** Gemini models that answer generateContent with text, aliases first, then newest version first. */
export function filterGeminiModels(raw: RawModel[]): GeminiModelInfo[] {
  const text = raw
    .map((model) => ({ id: model.name.replace(/^models\//, ""), displayName: model.displayName ?? model.name, methods: model.supportedGenerationMethods ?? [] }))
    .filter((model) => model.id.startsWith("gemini-") && model.methods.includes("generateContent") && !NOT_TEXT.test(model.id));
  const newest = Math.max(...text.map((model) => versionOf(model.id)).filter((v) => !Number.isNaN(v)));
  const group = (id: string): GeminiModelInfo["group"] => (id.endsWith("-latest") ? "alias" : versionOf(id) === newest ? "latest" : "older");
  const order = { alias: 0, latest: 1, older: 2 } as const;
  return text
    .map((model) => ({ id: model.id, displayName: model.displayName, group: group(model.id) }))
    .sort((a, b) => order[a.group] - order[b.group] || (versionOf(b.id) || 0) - (versionOf(a.id) || 0) || a.id.localeCompare(b.id));
}

let cache: { apiKey: string; at: number; models: GeminiModelInfo[] } | null = null;

/** Tests only */
export function resetModelListCache() {
  cache = null;
}

export async function listGeminiModels(options: { refresh?: boolean; fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<{ models: GeminiModelInfo[]; fetchedAt: string }> {
  const apiKey = secret("geminiApiKey");
  if (!apiKey) throw new ServiceError(409, "Geen Gemini-sleutel ingesteld.");
  if (!options.refresh && cache && cache.apiKey === apiKey && Date.now() - cache.at < CACHE_MS) {
    return { models: cache.models, fetchedAt: new Date(cache.at).toISOString() };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  // The key goes in a header, never in the URL (URLs end up in logs)
  const response = await fetchImpl(`${options.baseUrl ?? GOOGLE_BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response) throw new ServiceError(502, "Modellijst van Google niet bereikbaar.");
  if (response.status === 400 || response.status === 403) throw new ServiceError(400, "Google weigert de Gemini-sleutel.", { code: "key_rejected" });
  if (!response.ok) throw new ServiceError(502, "Modellijst van Google niet bereikbaar.");
  const body = (await response.json()) as { models?: RawModel[] };
  const models = filterGeminiModels(body.models ?? []);
  cache = { apiKey, at: Date.now(), models };
  return { models, fetchedAt: new Date(cache.at).toISOString() };
}
```

- [ ] **Step 4: Run filter test** → PASS.

- [ ] **Step 5: Controller** — `src/controllers/ai-admin.controller.ts`

```ts
import { generateText } from "ai";
import type { Request, Response } from "express";
import { respond } from "../http/service-error";
import { logger } from "../logger";
import { toGeminiError } from "../services/ai/gemini-error";
import { listGeminiModels } from "../services/ai/model-list";
import { requireAiModel } from "../services/ai/model";
import { adminConfig, setAiModels, type AiSlot } from "../settings/app-config";

/** Overridable in tests (local fake Google) */
export const modelListOptions: { fetchImpl?: typeof fetch; baseUrl?: string } = {};

export async function getModels(req: Request, res: Response) {
  return respond(res, 200, () => listGeminiModels({ ...modelListOptions, refresh: req.query.refresh === "1" }));
}

export async function putModels(req: Request, res: Response) {
  await setAiModels(req.body.models, req.user?.name ?? null);
  logger.info(`AI models changed by ${req.user?.name}: ${Object.entries(req.body.models).map(([slot, id]) => `${slot}=${id ?? "standaard"}`).join(", ")}`);
  return res.status(200).json(adminConfig());
}

/** One short call with the slot's model: is the key + model usable, and how fast */
export async function testModel(req: Request, res: Response) {
  const started = Date.now();
  try {
    await generateText({ model: requireAiModel(req.params.slot as AiSlot), prompt: "Antwoord met OK.", maxOutputTokens: 16, maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) });
    return res.status(200).json({ ok: true, ms: Date.now() - started });
  } catch (error) {
    return res.status(200).json({ ok: false, error: toGeminiError(error).message });
  }
}
```

- [ ] **Step 6: Routes** — in `src/routes/admin.route.ts`:

```ts
import * as aiAdminController from "../controllers/ai-admin.controller";
import { AI_SLOTS } from "../settings/app-config";

router.get("/ai/models", aiAdminController.getModels);
router.put(
  "/ai/models",
  validate([
    body("models").isObject().withMessage("Modellen zijn ongeldig."),
    body("models").custom((models) => Object.keys(models).every((slot) => (AI_SLOTS as readonly string[]).includes(slot))).withMessage("Onbekende AI-functie."),
    ...AI_SLOTS.map((slot) => body(`models.${slot}`).optional({ values: "null" }).isString().matches(/^[a-z0-9.\-]{3,80}$/).withMessage("Ongeldig model.")),
  ]),
  aiAdminController.putModels,
);
router.post("/ai/test/:slot", validate([param("slot").isIn(AI_SLOTS).withMessage("Onbekende AI-functie.")]), aiAdminController.testModel);
```

(Spec says unknown ids only if in the cached list; the id pattern check is enough because Google rejects unknown ids on use and the Test button shows that. Keep it simple.)

- [ ] **Step 7: Route test** — append to `src/routes/config.route.test.ts`:

```ts
import { modelListOptions } from "../controllers/ai-admin.controller";
import { resetModelListCache } from "../services/ai/model-list";

describe("admin AI", () => {
  test("model list comes from Google (key in a header) and is filtered", async () => {
    resetModelListCache();
    await fetch(`${base}/admin/config/secrets/geminiApiKey`, json(admin, "PUT", { value: "AIza-test-key" }));
    let seenKey: string | null = null;
    modelListOptions.fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenKey = new Headers(init?.headers).get("x-goog-api-key");
      return Response.json({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }] });
    }) as typeof fetch;
    const res = await fetch(`${base}/admin/ai/models`, as(admin));
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", group: "latest" }]);
    expect(seenKey).toBe("AIza-test-key");
    modelListOptions.fetchImpl = undefined;
  });

  test("a rejected key is a 400 with code key_rejected", async () => {
    resetModelListCache();
    await fetch(`${base}/admin/config/secrets/geminiApiKey`, json(admin, "PUT", { value: "AIza-bad-key" }));
    modelListOptions.fetchImpl = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const res = await fetch(`${base}/admin/ai/models`, as(admin));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("key_rejected");
    modelListOptions.fetchImpl = undefined;
  });

  test("PUT models saves per slot; unknown slots are 400", async () => {
    const ok = await fetch(`${base}/admin/ai/models`, json(admin, "PUT", { models: { split: "gemini-3.8-flash-lite", ocr: null } }));
    expect((await ok.json()).ai.split).toEqual({ value: "gemini-3.8-flash-lite", source: "db" });
    expect((await fetch(`${base}/admin/ai/models`, json(admin, "PUT", { models: { nope: "x" } }))).status).toBe(400);
  });

  test("test call without a key answers ok:false with the Dutch message", async () => {
    const res = await fetch(`${base}/admin/ai/test/ocr`, as(admin, { method: "POST" }));
    expect(await res.json()).toEqual({ ok: false, error: "Geen Gemini-sleutel ingesteld" });
  });
});
```

If `toGeminiError` rewrites the message of a `GeminiError` it receives, adjust `testModel` to `error instanceof GeminiError ? error.message : toGeminiError(error).message`.

- [ ] **Step 8: Run tests**

Run: `npx --yes bun test src/services/ai src/routes/config.route.test.ts && npx --yes bun x tsc --noEmit` → PASS.

- [ ] **Step 9: Commit**

```bash
git add -A src
git commit -m "feat(ai): admin model list from Google, per-slot model choice and test call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Jotihunt site login from the app config + test-login

**Files:**
- Modify: `src/services/jotihunt-scraper.service.ts:5-24`, `src/crons/schedule.ts:25-29`, `src/index.ts`
- Modify: `src/settings/app-config.controller.ts`, `src/routes/admin.route.ts`

**Interfaces:**
- Consumes: `plain("jotihuntWebUsername")`, `secret("jotihuntWebPassword")`, `onAppConfigChange` (Task 1).
- Produces: `jotihuntLogin(): { username: string; password: string } | null` (exported from the scraper), `testJotihuntLogin(login?: { username: string; password: string }): Promise<{ ok: true } | { ok: false; error: string }>`; HTTP `POST /admin/jotihunt/test-login` body `{ username?, password? }` → that result.

- [ ] **Step 1: Scraper reads the login per launch**

In `src/services/jotihunt-scraper.service.ts`, delete the `websiteUsername` / `websitePassword` constants and add:

```ts
import { onAppConfigChange, plain, secret } from "../settings/app-config";

/** The site login (Beheer → Algemeen, else JOTIHUNT_WEB_USERNAME/PASSWORD); null when incomplete */
export function jotihuntLogin(): { username: string; password: string } | null {
  const username = plain("jotihuntWebUsername");
  const password = secret("jotihuntWebPassword");
  return username && password ? { username, password } : null;
}
```

Change `logIn(page)` to `logIn(page, login = jotihuntLogin())`:

```ts
async function logIn(page: Page, login = jotihuntLogin()): Promise<void> {
  if (!login) throw new Error("No Jotihunt website login set");
  logger.info("(SCRAPER) Logging in to Jotihunt website with e-mail: " + login.username);
  await page.goto(websiteUrl + "/login", { waitUntil: "networkidle2" });
  await page.type('input[name="email"]', login.username);
  await page.type('input[name="password"]', login.password);
  // …rest unchanged
}
```

Below `closeScraper`, drop the session when the login changes:

```ts
// A changed login applies at the next scrape: close the logged-in browser
onAppConfigChange((part) => {
  if (part === "secrets") void closeScraper();
});

/** Try a login in a fresh browser (Beheer → "Inloggen testen"); closes it afterwards. */
export async function testJotihuntLogin(login = jotihuntLogin()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!websiteUrl) return { ok: false, error: "JOTIHUNT_WEB_URL is niet ingesteld op de server." };
  if (!login) return { ok: false, error: "Vul gebruikersnaam en wachtwoord in." };
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.env.NODE_ENV === "production" ? "/usr/bin/chromium" : undefined);
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"], ...(executablePath && { executablePath }) });
  try {
    const page = await browser.newPage();
    await page.setUserAgent({ userAgent });
    await logIn(page, login);
    return { ok: true };
  } catch {
    return { ok: false, error: "Inloggen mislukt: controleer gebruikersnaam en wachtwoord." };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
```

(Refactor `launch()` to reuse the same `executablePath`/args via a small `launchBrowser()` helper so the two don't drift.)

- [ ] **Step 2: Cron always scheduled, skipped per run without a login**

`src/crons/schedule.ts`:

```ts
  if (process.env.JOTIHUNT_WEB_URL) {
    // The login can be set later in Beheer: the job skips runs until it is
    cron.schedule("0 * * * * *", reportCronErrors("jotihunt-scraper", async () => (jotihuntLogin() ? scrapeJotihuntWebsite() : undefined)), { name: "jotihunt-scraper", noOverlap: true });
    if (!jotihuntLogin()) logger.warn("No Jotihunt website login (Beheer → Algemeen or JOTIHUNT_WEB_USERNAME/PASSWORD): the website scraper waits");
  } else {
    logger.warn("JOTIHUNT_WEB_URL is not set, skipping website scraper cron job");
  }
```

with `import { jotihuntLogin } from "../services/jotihunt-scraper.service";`. Check `scrapeJotihuntWebsite`'s return type matches (wrap in `async () => { if (jotihuntLogin()) await scrapeJotihuntWebsite(); }` if the types disagree).

- [ ] **Step 3: Endpoint**

Add to `src/settings/app-config.controller.ts`:

```ts
import { testJotihuntLogin } from "../services/jotihunt-scraper.service";

/** Test the posted login (form not yet saved) or, without a body, the saved one */
export async function postJotihuntTestLogin(req: Request, res: Response) {
  const { username, password } = req.body ?? {};
  const login = typeof username === "string" && typeof password === "string" && username && password ? { username, password } : undefined;
  return res.status(200).json(await testJotihuntLogin(login));
}
```

In `src/routes/admin.route.ts`: `router.post("/jotihunt/test-login", configController.postJotihuntTestLogin);`

- [ ] **Step 4: Verify**

Run: `npx --yes bun x tsc --noEmit && npx --yes bun test src/crons src/settings`
Expected: PASS. (No unit test launches Chromium; this is checked by hand in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(scraper): Jotihunt login from Beheer, test-login endpoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Telegram app credentials from the app config

**Files:**
- Modify: `src/services/telegram.service.ts:95-115` (config builder), `:158-160` (options), `:223-245` (available/status), add `reconfigure`
- Modify: `src/index.ts:111-128`
- Test: `src/services/telegram.service.test.ts` (add), `src/routes/telegram.route.test.ts` (adjust if it relies on `telegramConfigFromEnv`)

**Interfaces:**
- Consumes: `plain("telegramApiId")`, `plain("telegramBotUsername")`, `secret("telegramApiHash")`, `onAppConfigChange` (Task 1).
- Produces:
  - `telegramConfigFromSettings(env: Env, warn: (m: string) => void): TelegramConfig | null` (replaces `telegramConfigFromEnv`; same session-key checks)
  - `TelegramService.reconfigure(config: TelegramConfig | null): Promise<void>`
  - `TelegramAdminStatus.needsAppCredentials?: boolean` — true when state is `"unavailable"` only because API ID/hash are missing (session key OK)

- [ ] **Step 1: Write the failing test** — append to `src/services/telegram.service.test.ts` (reuse the file's existing fake gateway / service setup helpers; look at how other tests construct `TelegramService` with `createFakeGateway` from `src/test/telegram-gateway.ts`):

```ts
import { initAppConfig, resetAppConfig, setPlain, setSecret } from "../settings/app-config";
import { telegramConfigFromSettings } from "./telegram.service";

describe("telegram config from settings", () => {
  const SESSION = Buffer.alloc(32, 3).toString("base64");
  const SETTINGS = Buffer.alloc(32, 7).toString("base64");

  test("null without API ID/hash; built from Beheer values when set", async () => {
    resetAppConfig();
    await initAppConfig(db, { TELEGRAM_SESSION_KEY: SESSION, SETTINGS_KEY: SETTINGS });
    expect(telegramConfigFromSettings({ TELEGRAM_SESSION_KEY: SESSION }, () => {})).toBeNull();
    await setPlain({ telegramApiId: "2451873", telegramBotUsername: "@Other_bot" }, null);
    await setSecret("telegramApiHash", "abc123", null);
    expect(telegramConfigFromSettings({ TELEGRAM_SESSION_KEY: SESSION }, () => {})).toEqual({ apiId: 2451873, apiHash: "abc123", sessionKey: SESSION, botUsername: "Other_bot" });
  });

  test("status says app credentials are needed when only they are missing", async () => {
    const service = new TelegramService({ config: null, connection: db, gateway: () => { throw new Error("unused"); }, logger: silent, happyHour: fakeHappyHour, sessionKeyOk: true });
    expect(await service.status()).toEqual({ state: "unavailable", connected: false, needsAppCredentials: true });
  });
});
```

(Use the names the existing test file already has for the connection (`db`), silent logger and happy-hour fake; rename in this snippet to match.)

- [ ] **Step 2: Run to verify it fails** → FAIL (`telegramConfigFromSettings` missing).

- [ ] **Step 3: Implement**

Replace `telegramConfigFromEnv` with:

```ts
import { plain, secret } from "../settings/app-config";

/**
 * Config from Beheer (else TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_USERNAME), or null (feature off) without
 * an API ID and hash. A missing or invalid TELEGRAM_SESSION_KEY also turns the feature off, with a warning.
 */
export function telegramConfigFromSettings(env: Record<string, string | undefined>, warn: (message: string) => void): TelegramConfig | null {
  const rawId = plain("telegramApiId");
  const apiHash = secret("telegramApiHash");
  if (!rawId || !apiHash) return null;
  const apiId = Number(rawId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    warn("Telegram API ID is not a number, Telegram is off");
    return null;
  }
  const sessionKey = env.TELEGRAM_SESSION_KEY?.trim() ?? "";
  if (!isValidSessionKey(sessionKey)) {
    warn("TELEGRAM_SESSION_KEY is missing or not 32 bytes (base64), Telegram is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { apiId, apiHash, sessionKey, botUsername: plain("telegramBotUsername") || DEFAULT_BOT_USERNAME };
}
```

`TelegramServiceOptions`: add `/** TELEGRAM_SESSION_KEY is valid: without app credentials the status asks for them */ sessionKeyOk?: boolean;` and make `config` mutable (no `readonly`).

`status()` first line:

```ts
    if (!this.options.config) return { state: "unavailable", connected: false, ...(this.options.sessionKeyOk && { needsAppCredentials: true }) };
```

Add `needsAppCredentials?: boolean;` to `TelegramAdminStatus` with comment `/** Unavailable only because the API ID/hash are missing (set them in Beheer) */`.

Add the method after `stop()`:

```ts
  /** New app credentials from Beheer: drop the current connection and connect again with the stored link (if any). */
  async reconfigure(config: TelegramConfig | null): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.linkGeneration++;
    this.lastError = null;
    this.options.config = config;
    if (config) await this.connectStored();
  }
```

(Check `connectStored` exists under that name; it's called from `start()`.)

`src/index.ts` — replace the Telegram block's config lines:

```ts
const telegramWarn = (message: string) => logger.warn(message);
const telegramConfig = telegramConfigFromSettings(process.env, telegramWarn);
if (!telegramConfig) logger.warn("No Telegram app credentials (Beheer → Koppelingen or TELEGRAM_API_ID/TELEGRAM_API_HASH): tegenhunts are not read from Telegram");
const telegram = new TelegramService({
  config: telegramConfig,
  sessionKeyOk: isValidSessionKey(process.env.TELEGRAM_SESSION_KEY?.trim() ?? ""),
  connection: getDemoStateStore().connection,
  gateway: createMtcuteGateway,
  logger: serviceLogger,
  happyHour,
});
setTelegramService(telegram);
telegram.start().catch((error) => logger.error("Could not start the Telegram listener", error));
// New app credentials in Beheer: reconnect with them
let telegramKey = JSON.stringify(telegramConfig);
onAppConfigChange((part) => {
  if (part !== "secrets") return;
  const next = telegramConfigFromSettings(process.env, telegramWarn);
  if (JSON.stringify(next) === telegramKey) return;
  telegramKey = JSON.stringify(next);
  telegram.reconfigure(next).catch((error) => logger.error("Could not restart Telegram with the new app credentials", error));
});
```

Imports: `isValidSessionKey` from `./services/session-crypto`, `onAppConfigChange` from `./settings/app-config`, `telegramConfigFromSettings` instead of `telegramConfigFromEnv`. Update every other `telegramConfigFromEnv` use (`grep -rn telegramConfigFromEnv src`) — tests that built a config from an env object should now `initAppConfig(db, env)` first and call `telegramConfigFromSettings(env, …)`.

- [ ] **Step 4: Run tests**

Run: `npx --yes bun test src/services/telegram* src/routes/telegram.route.test.ts && npx --yes bun x tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(telegram): app credentials from Beheer, reconnect on change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Env examples, full test run, manual smoke

**Files:**
- Modify: `.env.example` (server), `/home/silke/Documents/Jotihunt 2026/.env.example` (root, not a git repo — edit in place)

- [ ] **Step 1: Server `.env.example`**

Remove these lines (and their comments): `HOME_TEAM_API_ID`, `GROUP_NAME`, `GROUP_WALKING_ID`, `GROUP_BIKE_ID`, `GROUP_CAR_ID`, `GROUP_MOTORCYCLE_ID`, `JOTIHUNT_WEB_USERNAME`, `JOTIHUNT_WEB_PASSWORD`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_CHAT_MODEL`, `GEMINI_PREDICTION_MODEL`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_USERNAME`. Add:

```
# Encrypts keys and passwords saved in Beheer (Gemini key, Jotihunt login, Telegram app hash).
# Generate with: openssl rand -base64 32
# Team, hunt times, vehicle groups, Gemini key/models, Jotihunt login and Telegram app details are set in Beheer.
# The old env vars (GEMINI_API_KEY, GROUP_NAME, …) still work as a fallback when Beheer has no value.
SETTINGS_KEY=
```

- [ ] **Step 2: Root `.env.example`** — same removals, plus `HUNT_START_TIME`, `HUNT_END_TIME`, `LOGO_URL`, `DISCORD_URL`; add the same `SETTINGS_KEY` block.

- [ ] **Step 3: Full verification**

Run: `npx --yes bun test 2>&1 | tail -5 && npx --yes bun x tsc --noEmit && npx --yes bun run lint`
Expected: all pass, 0 type errors, no lint errors.

- [ ] **Step 4: Manual smoke on a throwaway DB** (never the docker stack)

```bash
cd "/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server"
MONGO_URI=mongodb://localhost:27017/jotihunt-settings-smoke PORT=3099 JWT_SECRET=smoke-secret-smoke-secret-smoke-1 \
WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGINS=http://localhost:5173 PUBLIC_APP_URL=http://localhost:5173 \
SETTINGS_KEY=$(openssl rand -base64 32) JOTIHUNT_API_URL=http://127.0.0.1:9 \
npx --yes bun run src/index.ts &
echo $! > /tmp/settings-smoke.pid
sleep 6 && curl -s localhost:3099/config
```

Expected: JSON with `logoUrl: "/logo.svg"`. Stop with `kill $(cat /tmp/settings-smoke.pid)`.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "docs(env): moved settings live in Beheer; add SETTINGS_KEY

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
