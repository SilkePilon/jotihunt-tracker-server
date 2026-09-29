import { moveM, bearingDeg } from "../services/prediction/geo";
import type { LngLat } from "../services/prediction/types";
import type { DeviceSummary } from "../services/leaderboard.helpers";
import { groupIdForVehicle, type Vehicle, type VehicleGroups } from "../services/tracker-onboarding.helpers";
import { MINUTE_MS } from "./generator/constants";

/**
 * Simulated Traccar devices of the demo hunters (in memory, demo mode only). Positions are computed from the current
 * time on every request: each hunter drives/cycles/walks a wobbly loop around the centre of its fox area.
 */

export interface SimulatedHunter {
  deviceId: number;
  uniqueId: string;
  name: string;
  vehicle: Vehicle;
  centre: LngLat;
  radiusM: number;
  /** Start angle (radians) and direction (+1 counter-clockwise, -1 clockwise) */
  phase: number;
  direction: 1 | -1;
  /** Inactive hunters stopped sending 12 minutes ago */
  inactive: boolean;
  battery: number;
}

export interface Simulation {
  huntStart: Date;
  hunters: SimulatedHunter[];
}

export const VEHICLE_SPEED_KMH: Record<Vehicle, number> = { walking: 5, bike: 15, car: 40, motorcycle: 50 };
/** Part of the time a hunter is actually moving (for the distance travelled) */
const DUTY: Record<Vehicle, number> = { walking: 0.8, bike: 0.6, car: 0.45, motorcycle: 0.45 };
export const LOOP_RADIUS_M: Record<Vehicle, number> = { walking: 900, bike: 2500, car: 5000, motorcycle: 5000 };
export const INACTIVE_AFTER_MS = 12 * MINUTE_MS;
const MAX_DISTANCE_M = 150_000;
const KMH_PER_KNOT = 1.852;
const GROUP_NAMES: Record<Vehicle, string> = { walking: "Lopend", bike: "Fiets", car: "Auto", motorcycle: "Motor" };

let simulation: Simulation | null = null;

export function setSimulation(value: Simulation | null) {
  simulation = value;
}

export function getSimulation(): Simulation | null {
  return simulation;
}

/** When the hunter last sent a position. */
export function lastUpdateOf(hunter: SimulatedHunter, now: Date): Date {
  return hunter.inactive ? new Date(now.getTime() - INACTIVE_AFTER_MS) : now;
}

/** Position on the hunter's loop at `time`. */
export function hunterPosition(hunter: SimulatedHunter, huntStart: Date, time: Date): LngLat {
  const speedMs = (VEHICLE_SPEED_KMH[hunter.vehicle] * 1000) / 3_600_000;
  const travelled = Math.max(0, time.getTime() - huntStart.getTime()) * speedMs;
  const angle = hunter.phase + (hunter.direction * travelled) / hunter.radiusM;
  const wobble = 1 + 0.22 * Math.sin(3 * angle + hunter.phase) + 0.08 * Math.sin(7 * angle);
  const r = hunter.radiusM * wobble;
  return moveM(hunter.centre, Math.cos(angle) * r, Math.sin(angle) * r);
}

/** Distance travelled since hunt start (speed × moving time, capped). */
export function hunterDistanceM(hunter: SimulatedHunter, huntStart: Date, now: Date): number {
  const until = lastUpdateOf(hunter, now).getTime();
  const hours = Math.max(0, until - huntStart.getTime()) / 3_600_000;
  return Math.min(MAX_DISTANCE_M, Math.round(VEHICLE_SPEED_KMH[hunter.vehicle] * DUTY[hunter.vehicle] * hours * 1000));
}

function positionId(hunter: SimulatedHunter): number {
  return hunter.deviceId * 10;
}

/** The demo devices in the shape of GET /api/devices (plus groupName, like the tracker controller adds). */
export function simulatedDevices(now: Date, groups: VehicleGroups) {
  if (!simulation) return [];
  return simulation.hunters.map((hunter) => ({
    id: hunter.deviceId,
    name: hunter.name,
    uniqueId: hunter.uniqueId,
    status: hunter.inactive ? "offline" : "online",
    disabled: false,
    lastUpdate: lastUpdateOf(hunter, now).toISOString(),
    positionId: positionId(hunter),
    groupId: groupIdForVehicle(hunter.vehicle, groups),
    groupName: GROUP_NAMES[hunter.vehicle],
    phone: "",
    model: "",
    contact: "",
    category: hunter.vehicle === "walking" ? "person" : hunter.vehicle === "bike" ? "bicycle" : "car",
    attributes: {},
  }));
}

/** The demo positions in the shape of GET /tracker/positions (Traccar positions + deviceName). */
export function simulatedPositions(now: Date) {
  if (!simulation) return [];
  const { huntStart } = simulation;
  return simulation.hunters.map((hunter) => {
    const time = lastUpdateOf(hunter, now);
    const [longitude, latitude] = hunterPosition(hunter, huntStart, time);
    const ahead = hunterPosition(hunter, huntStart, new Date(time.getTime() + 20_000));
    const elapsedH = Math.max(0, time.getTime() - huntStart.getTime()) / 3_600_000;
    const moving = !hunter.inactive;
    return {
      id: positionId(hunter),
      attributes: {
        batteryLevel: Math.max(8, Math.round(hunter.battery - elapsedH * 6)),
        distance: moving ? Math.round((VEHICLE_SPEED_KMH[hunter.vehicle] / 3.6) * 5) : 0,
        totalDistance: hunterDistanceM(hunter, huntStart, now),
        motion: moving,
      },
      deviceId: hunter.deviceId,
      protocol: "osmand",
      serverTime: time.toISOString(),
      deviceTime: time.toISOString(),
      fixTime: time.toISOString(),
      outdated: false,
      valid: true,
      latitude,
      longitude,
      altitude: 12,
      speed: moving ? VEHICLE_SPEED_KMH[hunter.vehicle] / KMH_PER_KNOT : 0,
      course: Math.round((bearingDeg([longitude, latitude], ahead) + 360) % 360),
      address: "",
      accuracy: hunter.vehicle === "car" ? 6 : hunter.vehicle === "bike" ? 9 : 14,
      network: {},
      geofenceIds: [],
      deviceName: hunter.name,
    };
  });
}

/** Leaderboard summaries of the demo devices; null when there is no simulation. */
export function simulatedSummaries(now: Date): { from: Date; summaries: Map<number, DeviceSummary> } | null {
  if (!simulation) return null;
  const { huntStart } = simulation;
  const summaries = new Map<number, DeviceSummary>();
  for (const hunter of simulation.hunters) {
    summaries.set(hunter.deviceId, { distanceM: hunterDistanceM(hunter, huntStart, now), maxSpeedKmh: Math.round(VEHICLE_SPEED_KMH[hunter.vehicle] * 1.3) });
  }
  return { from: huntStart, summaries };
}

/** Change the vehicle of a simulated device (admin "voertuig wijzigen"); null when it is not a demo device. */
export function setSimulatedVehicle(deviceId: number, vehicle: Vehicle, groups: VehicleGroups): { deviceId: number; vehicle: Vehicle; groupId: number } | null {
  const hunter = simulation?.hunters.find((candidate) => candidate.deviceId === deviceId);
  if (!hunter) return null;
  hunter.vehicle = vehicle;
  hunter.radiusM = LOOP_RADIUS_M[vehicle];
  return { deviceId, vehicle, groupId: groupIdForVehicle(vehicle, groups) };
}
