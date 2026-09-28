/** Vehicle a hunter uses; drives the Traccar group (and so the map icon). */
export type Vehicle = "walking" | "bike" | "car" | "motorcycle";
export const VEHICLES: readonly Vehicle[] = ["walking", "bike", "car", "motorcycle"];
export const DEFAULT_VEHICLE: Vehicle = "walking";

/** A device counts as connected when Traccar received data within this window (same rule as "Actieve hunters"). */
export const CONNECTED_WINDOW_MS = 5 * 60 * 1000;
const KNOTS_TO_KMH = 1.852;

/** Traccar Client settings put in the QR code / deep link (the values the README recommends). */
export const CLIENT_SETTINGS: Readonly<Record<string, string>> = {
  accuracy: "highest",
  distance: "5",
  interval: "5",
  heartbeat: "30",
  buffer: "true",
  wakelock: "true",
  stop_detection: "true",
};

export type VehicleGroups = Record<Vehicle, number | undefined>;

export type NotConfiguredReason = "client_url_missing" | "client_url_invalid" | "api_missing" | "unreachable" | "group_invalid";

export interface TrackerStats {
  /** ISO time of the last data Traccar received */
  lastUpdate?: string;
  speedKmh?: number;
  /** Battery percentage (0-100) */
  battery?: number;
  accuracyM?: number;
  distanceTodayM?: number;
}

/** Stable, non-personal Traccar identifier for a user: `jh-` + the last 10 hex chars of the Mongo id. */
export function deriveUniqueId(userId: string): string {
  return `jh-${userId.slice(-10).toLowerCase()}`;
}

/**
 * Normalise TRACCAR_CLIENT_URL to `origin + path` (what the Traccar Client uses as server URL).
 * Returns null when the value is missing or not an http(s) URL.
 */
export function normalizeClientUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`;
}

/** QR payload: the server URL with the settings as query string (Traccar Client `applyUri`, http(s) branch). */
export function buildQrUrl(clientUrl: string, uniqueId: string): string {
  const params = new URLSearchParams({ id: uniqueId, ...CLIENT_SETTINGS });
  return `${clientUrl}?${params.toString()}`;
}

/** Deep link for phones: custom scheme, the server URL goes in the (encoded) `url` parameter. */
export function buildDeepLink(clientUrl: string, uniqueId: string): string {
  const params = new URLSearchParams({ url: clientUrl, id: uniqueId, ...CLIENT_SETTINGS });
  return `org.traccar.client://?${params.toString()}`;
}

function parseGroupId(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Traccar group ids per vehicle from GROUP_WALKING_ID / GROUP_BIKE_ID / GROUP_CAR_ID / GROUP_MOTORCYCLE_ID. */
export function vehicleGroupsFromEnv(env: Record<string, string | undefined> = process.env): VehicleGroups {
  return {
    walking: parseGroupId(env.GROUP_WALKING_ID),
    bike: parseGroupId(env.GROUP_BIKE_ID),
    car: parseGroupId(env.GROUP_CAR_ID),
    motorcycle: parseGroupId(env.GROUP_MOTORCYCLE_ID),
  };
}

/** Traccar uses groupId 0 for "no group". */
export function groupIdForVehicle(vehicle: Vehicle, groups: VehicleGroups): number {
  return groups[vehicle] ?? 0;
}

/** Reverse lookup for devices that already existed in Traccar; unknown group → undefined. */
export function vehicleForGroupId(groupId: number | null | undefined, groups: VehicleGroups): Vehicle | undefined {
  if (!groupId) return undefined;
  return VEHICLES.find((vehicle) => groups[vehicle] === groupId);
}

export function isConnected(lastUpdate: string | Date | null | undefined, now: Date): boolean {
  if (!lastUpdate) return false;
  const time = new Date(lastUpdate).getTime();
  if (Number.isNaN(time)) return false;
  return now.getTime() - time <= CONNECTED_WINDOW_MS;
}

/** Local midnight of `now` (the server runs with TZ=Europe/Amsterdam). */
export function startOfDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export interface StatsInput {
  lastUpdate?: string | Date | null;
  /** Knots, as Traccar reports it */
  speed?: number | null;
  batteryLevel?: unknown;
  accuracy?: number | null;
  distanceTodayM?: number | null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Map raw Traccar values to display units; missing or invalid fields are omitted. */
export function mapStats(input: StatsInput): TrackerStats {
  const stats: TrackerStats = {};
  if (input.lastUpdate) {
    const time = new Date(input.lastUpdate);
    if (!Number.isNaN(time.getTime())) stats.lastUpdate = time.toISOString();
  }
  if (finite(input.speed)) stats.speedKmh = Math.round(input.speed * KNOTS_TO_KMH * 10) / 10;
  if (finite(input.batteryLevel)) stats.battery = Math.round(input.batteryLevel);
  if (finite(input.accuracy) && input.accuracy > 0) stats.accuracyM = Math.round(input.accuracy);
  if (finite(input.distanceTodayM)) stats.distanceTodayM = Math.round(input.distanceTodayM);
  return stats;
}
