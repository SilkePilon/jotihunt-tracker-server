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
  /** A stored secret exists but can't be decrypted (SETTINGS_KEY missing or rotated): the env value is used instead */
  undecryptable: boolean;
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

/** The one `app-config` document in the `settings` collection of the control database */
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

/**
 * Hunt times belong to an edition (registry entry). With a source set they come only from it: no env fallback
 * (HUNT_START_TIME/HUNT_END_TIME only seed the registry once, see editions/database-switch.ts).
 */
export interface HuntTimesSource {
  read(): { huntStart: string | null; huntEnd: string | null };
  write(patch: { huntStart?: string | null; huntEnd?: string | null }): Promise<void>;
}
let huntTimes: HuntTimesSource | null = null;

export function setHuntTimesSource(source: HuntTimesSource | null) {
  huntTimes = source;
}

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

/** Loads the cached config; returns the names of stored secrets that can't be decrypted (for a startup warning). */
export async function initAppConfig(conn: Connection, environment: Env = process.env): Promise<{ undecryptable: SecretName[] }> {
  connection = conn;
  env = environment;
  doc = ((await conn.collection<AppConfigDoc>("settings").findOne({ key: DOC_KEY }, { projection: { _id: 0 } })) as AppConfigDoc | null) ?? { key: DOC_KEY };
  return { undecryptable: SECRET_NAMES.filter(isUndecryptable) };
}

/** Tests only */
export function resetAppConfig() {
  connection = null;
  env = process.env;
  doc = { key: DOC_KEY };
  huntTimes = null;
  events.removeAllListeners();
}

export function settingsKeyOk(): boolean {
  return isValidSessionKey(env.SETTINGS_KEY?.trim() ?? "");
}

export function general<K extends keyof GeneralValues>(key: K): Sourced<GeneralValues[K]> {
  const g = doc.general ?? {};
  switch (key) {
    case "huntStart":
    case "huntEnd": {
      const hunt = key as "huntStart" | "huntEnd";
      const envName = hunt === "huntStart" ? "HUNT_START_TIME" : "HUNT_END_TIME";
      if (!huntTimes) return pick(isoDate(g[hunt]), isoDate(env[envName]), null) as Sourced<GeneralValues[K]>;
      return pick(isoDate(huntTimes.read()[hunt]), null, null) as Sourced<GeneralValues[K]>;
    }
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

/** Where each vehicle group id comes from (the vehicleGroups source is "db" as soon as one of them is stored) */
export function vehicleGroupSources(): Record<VehicleKey, Sourced<number | null>> {
  const stored = doc.general?.vehicleGroups ?? {};
  return Object.fromEntries(VEHICLE_KEYS.map((v) => [v, pick(positiveInt(stored[v]), positiveInt(env[VEHICLE_ENV[v]]), null)])) as Record<VehicleKey, Sourced<number | null>>;
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

function isUndecryptable(name: SecretName): boolean {
  return Boolean(doc.secrets?.encrypted?.[name]) && dbSecret(name) === null;
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
  if (db !== null) return { set: true, hint: doc.secrets!.encrypted![name]!.hint, source: "db", undecryptable: false };
  const undecryptable = isUndecryptable(name);
  const fromEnv = text(env[SECRET_ENV[name]]);
  if (fromEnv !== null) return { set: true, hint: hintFor(name, fromEnv), source: "env", undecryptable };
  return { set: false, hint: null, source: "default", undecryptable };
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
  const huntPatch: { huntStart?: string | null; huntEnd?: string | null } = {};
  for (const key of ["huntStart", "huntEnd"] as const) {
    if (!(key in patch)) continue;
    if (huntTimes) huntPatch[key] = isoDate(patch[key]);
    else put(`general.${key}`, isoDate(patch[key]));
  }
  if (Object.keys(huntPatch).length) await huntTimes!.write(huntPatch);
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
