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
}

// --- Units ----------------------------------------------------------------------------------------------------------

/**
 * Life360 sends `accuracy` as a string. ha-life360 converts it from feet to metres; our one real sample ("50.0") can't
 * tell. The real test (compare with a known fix) is still pending: if it turns out to be metres, set this to 1.
 */
export const ACCURACY_TO_METRES = 0.3048;
/** `speed` is about m/s (ha-life360 multiplies by 2.25 for mph); negative means unknown. */
export const SPEED_TO_KMH = 3.6;
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

function parseLocation(raw: Raw): Life360Location | null {
  const shareLocation = record(raw.features)?.shareLocation;
  if (shareLocation === "0" || shareLocation === 0 || shareLocation === false) return null;
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

/** Members whose last fix is at most LIVE_WINDOW_MS old. */
export function liveCount(members: Life360Member[], now: Date): number {
  return members.filter((member) => member.location && now.getTime() - Date.parse(member.location.at) <= LIVE_WINDOW_MS).length;
}
