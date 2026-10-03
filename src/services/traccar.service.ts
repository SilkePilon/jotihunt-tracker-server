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

/** Devices change rarely; positions and devices are polled together, so share one fetch for a moment */
const DEVICES_CACHE_MS = 2000;
let devicesCache: { at: number; devices: Promise<TraccarDevice[]> } | undefined;

/**
 * Function to get all devices from Traccar.
 * @returns {Promise<Array>} - A promise that resolves to an array of devices.
 */
export async function getDevices(): Promise<Array<TraccarDevice>> {
  if (devicesCache && Date.now() - devicesCache.at < DEVICES_CACHE_MS) return devicesCache.devices;
  const devices = apiClient.get<TraccarDevice[]>("/api/devices").then((response) => response.data);
  devicesCache = { at: Date.now(), devices };
  try {
    return await devices;
  } catch (error) {
    devicesCache = undefined;
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
    const [devices, response] = await Promise.all([getDevices(), apiClient.get<TraccarPosition[]>("/api/positions")]);
    const names = new Map(devices.map((device) => [device.id, device.name]));
    return response.data.map((position: TraccarPosition) => ({
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
    const response = await apiClient.get<TraccarGroup[]>("/api/groups");
    return response.data;
  } catch (error) {
    logger.error(`Error fetching groups: ${describeTraccarError(error)}`);
    throw new Error("Could not fetch groups", { cause: error });
  }
}
