import type { NotificationInput } from "./notifier.helpers";

/** Without an end in the message a happy hour lasts an hour. */
export const HAPPY_HOUR_DEFAULT_MS = 60 * 60 * 1000;
/** A time more than this before the message is meant for the next day ("om 00:30" sent at 23:00 is fine either way). */
const ROLL_OVER_GRACE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = "Europe/Amsterdam";

export interface HappyHourWindow {
  startsAt: Date;
  endsAt: Date;
  /** False when no time was found (the coming hour from receipt) */
  parsed: boolean;
}

export type HappyHourPhase = "announce" | "start" | "end";

export type HappyHourView = { state: "none" } | { state: "upcoming" | "active"; startsAt: string; endsAt: string; text: string };

// --- Amsterdam wall clock -------------------------------------------------------------------------------------------

const PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function wallClock(time: number) {
  const parts = Object.fromEntries(PARTS.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Offset of Amsterdam from UTC at `time` (ms) */
function offsetAt(time: number): number {
  const wall = wallClock(time);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(time / 60_000) * 60_000;
}

/** `hours:minutes` in Amsterdam on the (Amsterdam) day of `reference`, plus `dayOffset` days. */
function amsterdamTime(reference: Date, hours: number, minutes: number, dayOffset = 0): Date {
  const day = wallClock(reference.getTime());
  const asUtc = Date.UTC(day.year, day.month - 1, day.day + dayOffset, hours, minutes);
  // Twice: the offset at the guess may differ from the offset at the result around a DST change
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first));
}

const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });

// --- Parsing --------------------------------------------------------------------------------------------------------

const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?`;
/** A time that needs minutes or "uur" to count ("om 21" alone is too vague) */
const T_STRICT = String.raw`(\d{1,2})(?:[:.](\d{2})|\s*uur)`;
const RANGE_PATTERNS = [
  new RegExp(String.raw`\bvan\s+${T}\s*(?:uur\s*)?tot\s+${T}`, "i"),
  new RegExp(String.raw`\btussen\s+${T}\s*(?:uur\s*)?en\s+${T}`, "i"),
  new RegExp(String.raw`\b(\d{1,2})[:.](\d{2})\s*(?:uur\s*)?(?:-|–|—|tot)\s*(\d{1,2})[:.](\d{2})`, "i"),
];
const UNTIL_PATTERN = new RegExp(String.raw`\btot\s+${T_STRICT}`, "i");
const FROM_PATTERN = new RegExp(String.raw`\b(?:om|vanaf)\s+${T_STRICT}`, "i");

type Time = { hours: number; minutes: number };
function toTime(hours: string | undefined, minutes: string | undefined): Time | null {
  const h = Number(hours);
  const m = minutes === undefined ? 0 : Number(minutes);
  if (hours === undefined || !Number.isInteger(h) || h > 23 || m > 59) return null;
  return { hours: h, minutes: m };
}

/** That time on the day of receipt, or the next day when it is more than an hour before receipt. */
function resolve(time: Time, receivedAt: Date): Date {
  const today = amsterdamTime(receivedAt, time.hours, time.minutes);
  return today.getTime() < receivedAt.getTime() - ROLL_OVER_GRACE_MS ? amsterdamTime(receivedAt, time.hours, time.minutes, 1) : today;
}

function windowOf(startsAt: Date, endsAt: Date, parsed: boolean): HappyHourWindow {
  // An end before the start is on the next day ("van 23:30 tot 00:30")
  while (endsAt.getTime() <= startsAt.getTime()) endsAt = new Date(endsAt.getTime() + DAY_MS);
  return { startsAt, endsAt, parsed };
}

/**
 * The happy hour window of a @Jotihunt_bot message, in Amsterdam time: "van 21:00 tot 22:00", "21:00 - 22:00",
 * "tussen 21 en 22 uur" (both), "tot 22:00" (from receipt), "om/vanaf 21:00" (an hour); otherwise the coming hour.
 */
export function parseHappyHourWindow(text: string, receivedAt: Date): HappyHourWindow {
  for (const pattern of RANGE_PATTERNS) {
    const match = pattern.exec(text);
    const start = match && toTime(match[1], match[2]);
    const end = match && toTime(match[3], match[4]);
    if (start && end) return windowOf(resolve(start, receivedAt), resolve(end, receivedAt), true);
  }
  const until = UNTIL_PATTERN.exec(text);
  const end = until && toTime(until[1], until[2]);
  if (end) return windowOf(receivedAt, resolve(end, receivedAt), true);
  const from = FROM_PATTERN.exec(text);
  const start = from && toTime(from[1], from[2]);
  if (start) {
    const startsAt = resolve(start, receivedAt);
    return windowOf(startsAt, new Date(startsAt.getTime() + HAPPY_HOUR_DEFAULT_MS), true);
  }
  return windowOf(receivedAt, new Date(receivedAt.getTime() + HAPPY_HOUR_DEFAULT_MS), false);
}

/** Two windows share time (touching ends don't count). */
export function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

// --- Notifications and view -----------------------------------------------------------------------------------------

/**
 * The three happy hour alerts: the announcement (sound), the start when it was announced for later (sound) and the
 * end (no sound: `urgent: false` and `data.silent`, clients skip the sound for it).
 */
export function buildHappyHourNotification(phase: HappyHourPhase, hour: { _id: unknown; startsAt: Date; endsAt: Date }, now: Date): NotificationInput {
  const data: Record<string, unknown> = { phase, happyHourId: String(hour._id), startsAt: hour.startsAt.toISOString(), endsAt: hour.endsAt.toISOString() };
  const until = clock(hour.endsAt);
  if (phase === "announce") {
    const when = hour.startsAt.getTime() > now.getTime() ? `Van ${clock(hour.startsAt)} tot ${until}` : `Vanaf nu tot ${until}`;
    return { type: "happy-hour", title: "Happy hour! Hunts tellen dubbel", body: `${when}. Tegenhunts tellen niet mee.`, urgent: true, data };
  }
  if (phase === "start") return { type: "happy-hour", title: "Happy hour begint nu", body: `Hunts tellen dubbel tot ${until}.`, urgent: true, data };
  return { type: "happy-hour", title: "Happy hour voorbij", body: "Hunts tellen weer normaal.", urgent: false, data: { ...data, silent: true } };
}

/** GET /happy-hour: the first window that has not ended. */
export function happyHourView(hour: { startsAt: Date; endsAt: Date; text: string } | null, now: Date): HappyHourView {
  if (!hour || hour.endsAt.getTime() <= now.getTime()) return { state: "none" };
  return {
    state: hour.startsAt.getTime() <= now.getTime() ? "active" : "upcoming",
    startsAt: hour.startsAt.toISOString(),
    endsAt: hour.endsAt.toISOString(),
    text: hour.text,
  };
}
