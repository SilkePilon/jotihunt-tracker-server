import { decodeSessionKey } from "./telegram.helpers";
/**
 * Life360: pure helpers and the API contract types (docs/superpowers/specs/2026-10-13-life360-api-contract.md).
 * Members of GET /v3/circles/{cid}/members are parsed here; addresses, place names, e-mail addresses, phone numbers and
 * Life360 URLs are dropped and never reach the API or the logs.
 */

// --- Contract types -------------------------------------------------------------------------------------------------

export interface Life360Circle {
  id: string;
  name: string;
}

export type Life360AdminStatus =
  | { state: "unavailable" }
  | { state: "unlinked" }
  | { state: "code"; email: string; resendAt: string }
  | { state: "circle"; email: string; circles: Life360Circle[] }
  | { state: "linked"; email: string; circleName: string; memberCount: number; liveCount: number; lastPollAt: string | null; refreshAvailableAt: string | null }
  | { state: "loggedOut"; email: string; circleName: string }
  | { state: "paused"; email: string; circleName: string; retryAt: string; memberCount: number; liveCount: number };

export interface Life360Location {
  lat: number;
  lon: number;
  accuracyM: number;
  at: string;
  driving: boolean;
  speedKmh: number | null;
  battery: number | null;
  charging: boolean;
}

export interface Life360Member {
  id: string;
  /** firstName + " " + first letter of lastName + "." (lastName empty → firstName) */
  name: string;
  initials: string;
  /** "/life360/avatar/<id>" (relative to the API base) when Life360 has an avatar */
  avatarUrl: string | null;
  /** null: not sharing / no fix */
  location: Life360Location | null;
}

export interface Life360Members {
  linked: boolean;
  stale: boolean;
  members: Life360Member[];
}

/** A parsed member plus its Life360 avatar URL (server-side only: the browser gets /life360/avatar/<id>). */
export interface ParsedLife360Member {
  member: Life360Member;
  avatarSource: string | null;
  /** false only when Life360 says shareLocation is off; a sharing member may still come without a location */
  sharing: boolean;
}

// --- Units ----------------------------------------------------------------------------------------------------------

/**
 * v3 only (v5 accuracy is taken as metres). Life360 v3 sends `accuracy` as a string. ha-life360 converts it from feet to metres; our one real sample ("50.0") can't
 * tell. The real test (compare with a known fix) is still pending: if it turns out to be metres, set this to 1.
 */
export const ACCURACY_TO_METRES = 0.3048;
/** `speed` is about m/s (ha-life360 multiplies by 2.25 for mph); negative means unknown. */
export const SPEED_TO_KMH = 3.6;
/**
 * v5 has no isDriving flag: a device counts as driving when Life360 says inTransit, or its speed (m/s) is at least this
 * (18 km/h: above walking and jogging, so a hunter on foot is not shown as driving; a car in town is).
 */
export const DRIVING_SPEED_MS = 5;
/** A member whose last fix is at most this old counts as live (liveCount). */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

// --- Parsing --------------------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const record = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);

const text = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const number = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Life360 booleans are "0"/"1" strings */
const flag = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true";

/** Unix seconds (string or number) → ISO; values above 1e12 are taken as milliseconds. */
export function life360Time(value: unknown): string | null {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return null;
  const date = new Date(parsed > 1e12 ? parsed : parsed * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "Bram" + "de Vries" → "Bram D." / "BD"; without a last name the first name only. */
export function memberName(firstName: unknown, lastName: unknown): { name: string; initials: string } {
  const first = text(firstName) ?? "";
  const last = text(lastName) ?? "";
  const name = [first, last ? `${last[0].toUpperCase()}.` : ""].filter(Boolean).join(" ");
  const initials = `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
  return name ? { name, initials } : { name: "Onbekend", initials: "?" };
}

function isSharing(raw: Raw): boolean {
  const shareLocation = record(raw.features)?.shareLocation;
  return !(shareLocation === "0" || shareLocation === 0 || shareLocation === false);
}

function parseLocation(raw: Raw): Life360Location | null {
  if (!isSharing(raw)) return null;
  const location = record(raw.location);
  if (!location) return null;
  const lat = number(location.latitude);
  const lon = number(location.longitude);
  const at = life360Time(location.timestamp);
  if (lat === null || lon === null || at === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const accuracy = number(location.accuracy);
  const speed = number(location.speed);
  const battery = number(location.battery);
  return {
    lat,
    lon,
    accuracyM: accuracy !== null && accuracy > 0 ? Math.round(accuracy * ACCURACY_TO_METRES) : 0,
    at,
    driving: flag(location.isDriving),
    speedKmh: speed !== null && speed >= 0 ? Math.round(speed * SPEED_TO_KMH) : null,
    battery: battery !== null && battery >= 0 ? Math.min(Math.round(battery), 100) : null,
    charging: flag(location.charge),
  };
}

function parseMember(value: unknown): ParsedLife360Member | null {
  const raw = record(value);
  const id = raw ? text(raw.id) : null;
  if (!raw || !id) return null;
  const avatar = text(raw.avatar);
  const avatarSource = avatar && avatar.startsWith("https://") ? avatar : null;
  return {
    member: {
      id,
      ...memberName(raw.firstName, raw.lastName),
      avatarUrl: avatarSource ? `/life360/avatar/${encodeURIComponent(id)}` : null,
      location: parseLocation(raw),
    },
    avatarSource,
    sharing: isSharing(raw),
  };
}

/** The `members` array of GET /v3/circles/{cid}/members; members without id are skipped, Life360's order is kept. */
export function parseMembers(list: unknown): ParsedLife360Member[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((value) => {
    const parsed = parseMember(value);
    return parsed ? [parsed] : [];
  });
}

// --- v5 device locations --------------------------------------------------------------------------------------------

/** One device of GET /v5/circles/devices/locations: its owner (the v3 member id) and the position. */
export interface Life360DeviceLocation {
  userId: string;
  location: Life360Location;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDevice(value: unknown): Life360DeviceLocation | null {
  const raw = record(value);
  if (!raw) return null;
  const owners = Array.isArray(raw.owners) ? raw.owners : [];
  const userId = text(record(owners[0])?.userId);
  const lat = number(raw.latitude);
  const lon = number(raw.longitude);
  const at = isoTime(raw.lastObserved);
  if (!userId || lat === null || lon === null || at === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  // v5 sends numbers; accuracy is taken as metres (the app shows the same 50 as v3's "50.0", which ha-life360 reads as feet)
  const accuracy = number(raw.accuracy);
  const speed = number(raw.speed);
  const battery = number(raw.batteryLevel);
  return {
    userId,
    location: {
      lat,
      lon,
      accuracyM: accuracy !== null && accuracy > 0 ? Math.round(accuracy) : 0,
      at,
      driving: raw.inTransit === true || (speed !== null && speed >= DRIVING_SPEED_MS),
      speedKmh: speed !== null && speed >= 0 ? Math.round(speed * SPEED_TO_KMH) : null,
      battery: battery !== null && battery >= 0 ? Math.min(Math.round(battery), 100) : null,
      charging: raw.batteryCharging === true,
    },
  };
}

/**
 * The items of GET /v5/circles/devices/locations (the array, or the whole `{data:{items}}` answer), one entry per device
 * with a usable fix. Only the position fields come out (no device ids, wifi or app details).
 */
export function parseDeviceLocations(raw: unknown): Life360DeviceLocation[] {
  const items = Array.isArray(raw) ? raw : record(record(raw)?.data)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const parsed = parseDevice(item);
    return parsed ? [parsed] : [];
  });
}

/** One position per member: with several devices, the one with the most recent lastObserved. */
export function latestByUser(devices: Life360DeviceLocation[]): Map<string, Life360Location> {
  const byUser = new Map<string, Life360Location>();
  for (const { userId, location } of devices) {
    const current = byUser.get(userId);
    if (!current || Date.parse(location.at) > Date.parse(current.at)) byUser.set(userId, location);
  }
  return byUser;
}

/**
 * The members of the v3 roster with their position: the v5 position when there is one; else the v3 position; else the
 * last known position (`previous`) while the member still shares (Life360 sometimes answers no position for minutes).
 * A v3 position older than the last known one is skipped, so a member never jumps back in time. Not sharing: null.
 */
export function mergeLocations(roster: ParsedLife360Member[], devices: Map<string, Life360Location>, previous: Map<string, Life360Location | null>): Life360Member[] {
  return roster.map(({ member, sharing }) => {
    if (!sharing) return { ...member, location: null };
    const v5 = devices.get(member.id);
    if (v5) return { ...member, location: v5 };
    const known = previous.get(member.id) ?? null;
    const v3 = member.location;
    if (v3 && (!known || Date.parse(v3.at) >= Date.parse(known.at))) return member;
    return { ...member, location: known };
  });
}

/** Members whose last fix is at most LIVE_WINDOW_MS old. */
export function liveCount(members: Life360Member[], now: Date): number {
  return members.filter((member) => member.location && now.getTime() - Date.parse(member.location.at) <= LIVE_WINDOW_MS).length;
}

// --- Config ---------------------------------------------------------------------------------------------------------

export interface Life360Config {
  /** LIFE360_SESSION_KEY: base64 of 32 bytes, encrypts the stored token (AES-256-GCM, same helpers as Telegram) */
  sessionKey: string;
}

/** Config from the environment, or null (feature off: state "unavailable"). An invalid key also turns it off, with a warning. */
export function life360ConfigFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): Life360Config | null {
  const sessionKey = env.LIFE360_SESSION_KEY?.trim();
  if (!sessionKey) return null;
  try {
    decodeSessionKey(sessionKey);
  } catch {
    warn("LIFE360_SESSION_KEY is not 32 bytes (base64), Life360 is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { sessionKey };
}
