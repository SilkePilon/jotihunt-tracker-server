import { logger } from "../logger";
import { describeTraccarError, traccarHttp as apiClient } from "./traccar-http";

export { isTraccarConfigured } from "./traccar-http";

/**
 * API interface for a Traccar position.
 */
export interface TraccarPosition {
  id: number;
  attributes: {
    batteryLevel: number;
    distance: number;
    totalDistance: number;
    motion: boolean;
  };
  deviceId: number;
  protocol: string;
  serverTime: Date;
  deviceTime: Date;
  outdated: boolean;
  valid: boolean;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  course: number;
  address: string;
  accuracy: number;
  network: object;
  geofenceIds: number[];
}

/**
 * API interface for a Traccar device.
 */
export interface TraccarDevice {
  id: number;
  name: string;
  uniqueId: string;
  status: string;
  disabled: boolean;
  lastUpdate: Date;
  positionId: number;
  groupId: number;
  groupName?: string; // Filled by implementation
  phone: string;
  model: string;
  contact: string;
  category: string;
  attributes: {
    deviceImage: string;
  };
}

export interface TraccarGroup {
  id: number;
  name: string;
}

/**
 * Every hunter polls devices and positions; share one Traccar fetch per list for a moment
 * (a failed fetch is not kept, the next call tries again).
 */
const SHARED_FETCH_MS = 2000;
const sharedFetches = new Map<string, { at: number; list: Promise<unknown[]> }>();

/** Tests only */
export function clearTraccarCache() {
  sharedFetches.clear();
}

/** GET a Traccar list, shared for SHARED_FETCH_MS; null and non-object entries are skipped. */
function getList<T>(path: string): Promise<T[]> {
  const cached = sharedFetches.get(path);
  if (cached && Date.now() - cached.at < SHARED_FETCH_MS) return cached.list as Promise<T[]>;
  const list = apiClient.get<unknown>(path).then((response) => {
    if (!Array.isArray(response.data)) throw new Error(`GET ${path} → unexpected response`);
    return response.data.filter((item): item is T => typeof item === "object" && item !== null);
  });
  const entry = { at: Date.now(), list };
  sharedFetches.set(path, entry);
  list.catch(() => {
    if (sharedFetches.get(path) === entry) sharedFetches.delete(path);
  });
  return list;
}

/**
 * Function to get all devices from Traccar.
 * @returns {Promise<Array>} - A promise that resolves to an array of devices.
 */
export async function getDevices(): Promise<Array<TraccarDevice>> {
  try {
    return await getList<TraccarDevice>("/api/devices");
  } catch (error) {
    logger.error(`Error fetching devices: ${describeTraccarError(error)}`);
    throw new Error("Could not fetch devices", { cause: error });
  }
}

/**
 * Function to get all positions from Traccar.
 * @returns {Promise<Array>} - A promise that resolves to an array of positions with device names.
 */
export async function getPositions(): Promise<Array<TraccarPosition>> {
  try {
    const [devices, positions] = await Promise.all([getDevices(), getList<TraccarPosition>("/api/positions")]);
    const names = new Map(devices.map((device) => [device.id, device.name]));
    return positions.map((position: TraccarPosition) => ({
      ...position,
      deviceName: names.get(position.deviceId) ?? "Unknown Device",
    }));
  } catch (error) {
    logger.error(`Error fetching positions: ${describeTraccarError(error)}`);
    throw new Error("Could not fetch positions", { cause: error });
  }
}

/**
 * Function to get all groups from Traccar.
 * @returns {Promise<Array>} - A promise that resolves to an array of groups.
 */
export async function getGroups(): Promise<Array<TraccarGroup>> {
  try {
    return await getList<TraccarGroup>("/api/groups");
  } catch (error) {
    logger.error(`Error fetching groups: ${describeTraccarError(error)}`);
    throw new Error("Could not fetch groups", { cause: error });
  }
}
