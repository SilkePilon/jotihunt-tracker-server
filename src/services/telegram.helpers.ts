import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { buildCounterHuntNotification, COUNTER_HUNT_DIRECTIONS, type CounterHuntDirection, type NotificationInput } from "./notifier.helpers";

/** What a @Jotihunt_bot message is about (decides the marker in the client's card; only tegenhunts alert). */
export const BOT_MESSAGE_KINDS = ["tegenhunt", "hunt-approved", "hunt-rejected", "assignment", "happy-hour", "other"] as const;
export type BotMessageKind = (typeof BOT_MESSAGE_KINDS)[number];

/** A tegenhunt lasts 30 minutes from its start (rules §6). */
export const COUNTER_HUNT_WINDOW_MS = 30 * 60 * 1000;

export type CounterHuntView =
  | { active: true; direction: number | null; startedAt: string; endsAt: string; text?: string }
  | { active: false; last?: { direction: number | null; startedAt: string } };

/** Words of a tegenhunt start announcement (rules §6: start time, wind direction, 30 minutes) */
const COUNTER_HUNT_START = /\b(?:gestart|start\w*|begint|begonnen|windrichting|richting|minuten)\b|\d{1,2}[:.]\d{2}/i;

/**
 * Keyword rules in order; the first match wins. "tegenhunt" also appears in other messages ("tegenhunts tellen niet",
 * "jullie tegenhunt is goedgekeurd"), so it only counts after the other kinds and together with a start word.
 */
const KIND_RULES: [(text: string) => boolean, BotMessageKind][] = [
  [(text) => /happy[- ]?hour/i.test(text), "happy-hour"],
  [(text) => /goedgekeurd/i.test(text), "hunt-approved"],
  [(text) => /afgekeurd/i.test(text), "hunt-rejected"],
  [(text) => /tegen[- ]?hunt/i.test(text) && COUNTER_HUNT_START.test(text), "tegenhunt"],
  [(text) => /opdracht|inzending/i.test(text), "assignment"],
];

export function classifyBotMessage(text: string): BotMessageKind {
  return KIND_RULES.find(([matches]) => matches(text))?.[1] ?? "other";
}

// --- Direction ---------------------------------------------------------------------------------------------------

/** Compass points in degrees: Dutch names (16-point included) and their abbreviations. */
const POINTS: { name: string; short: string; degrees: number }[] = [
  { name: "noord", short: "N", degrees: 0 },
  { name: "noordnoordoost", short: "NNO", degrees: 22.5 },
  { name: "noordoost", short: "NO", degrees: 45 },
  { name: "oostnoordoost", short: "ONO", degrees: 67.5 },
  { name: "oost", short: "O", degrees: 90 },
  { name: "oostzuidoost", short: "OZO", degrees: 112.5 },
  { name: "zuidoost", short: "ZO", degrees: 135 },
  { name: "zuidzuidoost", short: "ZZO", degrees: 157.5 },
  { name: "zuid", short: "Z", degrees: 180 },
  { name: "zuidzuidwest", short: "ZZW", degrees: 202.5 },
  { name: "zuidwest", short: "ZW", degrees: 225 },
  { name: "westzuidwest", short: "WZW", degrees: 247.5 },
  { name: "west", short: "W", degrees: 270 },
  { name: "westnoordwest", short: "WNW", degrees: 292.5 },
  { name: "noordwest", short: "NW", degrees: 315 },
  { name: "noordnoordwest", short: "NNW", degrees: 337.5 },
];
const byLength = <T>(key: (point: (typeof POINTS)[number]) => string) => [...POINTS].sort((a, b) => key(b).length - key(a).length).map(key) as T[];

/** "noordoost" also as "noord-oost"/"noord oost"; "-en" for "uit het noordoosten". Not "Oosterbeek" or "noordelijk". */
const namePattern = (name: string) => name.replace(/(noord|oost|zuid|west)(?=noord|oost|zuid|west)/g, "$1[- ]?");
const NAME_ALTERNATION = byLength<string>((point) => point.name).map(namePattern).join("|");
const SHORT_ALTERNATION = byLength<string>((point) => point.short).join("|");
/** A compass word: group 1 a name, group 2 an abbreviation */
const COMPASS = `(?:\\b(${NAME_ALTERNATION})(?:en)?(?![a-z])|\\b(${SHORT_ALTERNATION})\\b)`;
/** Right after "(wind)richting", "uit (het)" or "vanuit (het)": any case, abbreviations too */
const CONTEXT_REGEX = new RegExp(`(?:richting\\s*:?\\s*|\\b(?:van)?uit\\s+(?:het\\s+)?)${COMPASS}`, "gi");
/** Elsewhere: names in any case, abbreviations only in capitals ("zo"/"no"/"o" are ordinary Dutch words) */
const NAME_REGEX = new RegExp(`\\b(${NAME_ALTERNATION})(?:en)?(?![a-z])`, "gi");
const SHORT_REGEX = new RegExp(`\\b(${SHORT_ALTERNATION})\\b`, "g");
const DEGREES_REGEX = /(\d{1,3}(?:[.,]\d+)?)\s*(?:°|graden\b|deg(?:rees)?\b)/i;

const nearestDirection = (degrees: number): CounterHuntDirection => ((Math.round(degrees / 45) * 45) % 360) as CounterHuntDirection;
const pointDegrees = (match: string, key: "name" | "short") => {
  const normalized = match.toLowerCase().replace(/[- ]/g, "");
  return POINTS.find((point) => point[key].toLowerCase() === normalized)?.degrees;
};

/** The one direction of these matches; null for none or when they disagree. */
function agreed(directions: CounterHuntDirection[]): CounterHuntDirection | null {
  const distinct = new Set(directions);
  return distinct.size === 1 ? directions[0] : null;
}

/**
 * Wind direction of a tegenhunt message, as one of the 8 directions of the Tegenhunt card; null when none is found or
 * the message names different ones. Degrees first; then the compass words right after "(wind)richting"/"(van)uit
 * het" (so "vanuit Arnhem-Zuid, windrichting noordoost" is noordoost); only without those any compass word.
 * 16-point directions round to the nearest (ties clockwise).
 */
export function parseCounterHuntDirection(text: string): CounterHuntDirection | null {
  const degrees = DEGREES_REGEX.exec(text);
  if (degrees) {
    const value = Number(degrees[1].replace(",", "."));
    if (value >= 0 && value <= 360) return nearestDirection(value);
  }
  const inContext = [...text.matchAll(CONTEXT_REGEX)].map((match) => nearestDirection(match[1] ? pointDegrees(match[1], "name")! : pointDegrees(match[2], "short")!));
  if (inContext.length > 0) return agreed(inContext);
  const bare = [
    ...[...text.matchAll(NAME_REGEX)].map((match) => nearestDirection(pointDegrees(match[1], "name")!)),
    ...[...text.matchAll(SHORT_REGEX)].map((match) => nearestDirection(pointDegrees(match[1], "short")!)),
  ];
  return bare.length > 0 ? agreed(bare) : null;
}

// Keep the parser in sync with the card's choices
if (POINTS.some((point) => !COUNTER_HUNT_DIRECTIONS.includes(nearestDirection(point.degrees)))) throw new Error("Unknown counter-hunt direction");

/**
 * A message of the bot itself: the configured username (case-insensitive, with or without "@"), sent by a bot, in the
 * private chat with it (not e.g. a group the bot is in).
 */
export function isBotMessage(message: { senderUsername?: string | null; senderIsBot?: boolean; privateChat?: boolean }, botUsername: string): boolean {
  if (!message.senderUsername || !message.senderIsBot || !message.privateChat) return false;
  const normalize = (username: string) => username.trim().replace(/^@/, "").toLowerCase();
  return normalize(message.senderUsername) === normalize(botUsername);
}

// --- Session ------------------------------------------------------------------------------------------------------

export interface EncryptedSession {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** TELEGRAM_SESSION_KEY: base64 of exactly 32 bytes (AES-256). Throws otherwise. */
export function decodeSessionKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64.trim(), "base64");
  if (key.length !== 32) throw new Error("TELEGRAM_SESSION_KEY must be 32 bytes, base64 encoded");
  return key;
}

/** AES-256-GCM with a fresh 12-byte iv; all parts base64. */
export function encryptSession(plain: string, keyB64: string): EncryptedSession {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeSessionKey(keyB64), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** Throws on a wrong key or tampered data (GCM authentication). */
export function decryptSession(encrypted: EncryptedSession, keyB64: string): string {
  const decipher = createDecipheriv("aes-256-gcm", decodeSessionKey(keyB64), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** "+31612345612" → "+31 6 ••• 12": enough for an admin to recognise the account. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  return `+${digits.slice(0, 2)} ${digits[2]} ••• ${digits.slice(-2)}`;
}

// --- Counter-hunt view ----------------------------------------------------------------------------------------------

const toDate = (value: unknown, fallback: Date) => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : fallback;
};

/** The Tegenhunt card's state from the latest counter-hunt notification: active for 30 minutes from its start. */
export function counterHuntView(latest: { data?: Record<string, unknown> | null; createdAt: Date } | null, now: Date): CounterHuntView {
  if (!latest) return { active: false };
  const data = latest.data ?? {};
  const direction = typeof data.direction === "number" ? data.direction : null;
  const startedAt = toDate(data.startedAt, latest.createdAt);
  const endsAt = new Date(startedAt.getTime() + COUNTER_HUNT_WINDOW_MS);
  if (now >= endsAt) return { active: false, last: { direction, startedAt: startedAt.toISOString() } };
  const view: CounterHuntView = { active: true, direction, startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString() };
  if (direction === null && typeof data.text === "string") view.text = data.text;
  return view;
}

/**
 * The alert for a tegenhunt message from the bot: the card's usual notification when the direction was recognised,
 * otherwise a generic one that points to the bot's message (its text is in `data.text`).
 */
export function buildTelegramCounterHuntNotification(message: { telegramId: number; text: string; date: Date }): NotificationInput {
  const direction = parseCounterHuntDirection(message.text);
  const extra = { telegramId: message.telegramId, startedAt: message.date.toISOString() };
  if (direction !== null) {
    const notification = buildCounterHuntNotification(direction, "Telegram");
    return { ...notification, data: { ...notification.data, ...extra } };
  }
  return {
    type: "counter-hunt",
    title: "Tegenhunt!",
    body: "Richting niet herkend, lees het bericht van de Jotihunt-bot.",
    urgent: true,
    data: { direction: null, text: message.text, ...extra },
  };
}
