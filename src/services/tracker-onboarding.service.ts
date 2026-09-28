import { User, type UserType } from "../models/user.model";
import type { TraccarApi, TraccarDeviceDto } from "./traccar-api";
import { isGroupInvalidError } from "./traccar-http";
import {
  buildDeepLink,
  buildQrUrl,
  DEFAULT_VEHICLE,
  deriveUniqueId,
  groupIdForVehicle,
  isConnected,
  mapStats,
  normalizeClientUrl,
  startOfDay,
  vehicleForGroupId,
  type NotConfiguredReason,
  type TrackerStats,
  type Vehicle,
  type VehicleGroups,
} from "./tracker-onboarding.helpers";

export type TrackerMe =
  | { configured: false; reason: NotConfiguredReason; connected: false }
  | {
      configured: true;
      qrUrl: string;
      deepLink: string;
      uniqueId: string;
      vehicle: Vehicle;
      connected: boolean;
      stats: TrackerStats;
    };

export interface TrackerOnboardingDeps {
  /** null when TRACCARR_API_URL / TRACCARR_API_TOKEN are missing */
  api: TraccarApi | null;
  /** Raw TRACCAR_CLIENT_URL */
  clientUrl: string | undefined;
  groups: VehicleGroups;
  now?: () => Date;
  /** Called when Traccar fails (the controller logs it); the response then says `unreachable`. */
  onError?: (error: unknown) => void;
}

export interface EnsuredDevice {
  device: TraccarDeviceDto;
  vehicle: Vehicle;
}

const notConfigured = (reason: NotConfiguredReason): TrackerMe => ({ configured: false, reason, connected: false });

/** `group_invalid` when Traccar rejected a create/update because of a bad GROUP_*_ID, else `unreachable`. */
const reasonFor = (error: unknown): NotConfiguredReason => (isGroupInvalidError(error) ? "group_invalid" : "unreachable");

export function createTrackerOnboarding(deps: TrackerOnboardingDeps) {
  const now = deps.now ?? (() => new Date());
  const clientUrl = normalizeClientUrl(deps.clientUrl);

  /** Why the card can't be used, or null when everything is configured. */
  function configurationProblem(): NotConfiguredReason | null {
    if (!deps.clientUrl?.trim()) return "client_url_missing";
    if (!clientUrl) return "client_url_invalid";
    if (!deps.api) return "api_missing";
    return null;
  }

  function requireApi(): TraccarApi {
    if (!deps.api) throw new Error("Traccar API is not configured");
    return deps.api;
  }

  /**
   * Make sure the user's Traccar device exists: look it up by its (deterministic) uniqueId and create it when
   * missing, also when it was deleted in Traccar. Stores `{ deviceId, uniqueId, vehicle }` on the user.
   */
  async function ensureDevice(user: UserType): Promise<EnsuredDevice> {
    const api = requireApi();
    const uniqueId = deriveUniqueId(user._id.toString());
    const storedVehicle = user.tracker?.vehicle as Vehicle | undefined;
    let device = await api.findDevice(uniqueId);
    if (!device) {
      try {
        device = await api.createDevice({
          name: user.name,
          uniqueId,
          groupId: groupIdForVehicle(storedVehicle ?? DEFAULT_VEHICLE, deps.groups),
        });
      } catch (error) {
        // A concurrent request may have created the device first (duplicate uniqueId): use that one
        device = await api.findDevice(uniqueId);
        if (!device) throw error;
      }
    }
    const vehicle = storedVehicle ?? vehicleForGroupId(device.groupId, deps.groups) ?? DEFAULT_VEHICLE;
    if (user.tracker?.deviceId !== device.id || user.tracker?.uniqueId !== uniqueId || user.tracker?.vehicle !== vehicle) {
      user.tracker = { deviceId: device.id, uniqueId, vehicle };
      await user.save();
    }
    return { device, vehicle };
  }

  /** Connected flag and stats; position and distance failures only drop those stats. */
  async function status(device: TraccarDeviceDto): Promise<{ connected: boolean; stats: TrackerStats }> {
    const api = requireApi();
    const current = now();
    const [position, distance] = await Promise.all([
      device.positionId ? api.getPosition(device.positionId).catch(() => null) : Promise.resolve(null),
      api.getDistance(device.id, startOfDay(current), current).catch(() => null),
    ]);
    return {
      connected: isConnected(device.lastUpdate, current),
      stats: mapStats({
        lastUpdate: device.lastUpdate,
        speed: position?.speed,
        batteryLevel: position?.attributes?.batteryLevel,
        accuracy: position?.accuracy,
        distanceTodayM: distance,
      }),
    };
  }

  async function describe(ensured: EnsuredDevice): Promise<TrackerMe> {
    const uniqueId = ensured.device.uniqueId;
    return {
      configured: true,
      qrUrl: buildQrUrl(clientUrl!, uniqueId),
      deepLink: buildDeepLink(clientUrl!, uniqueId),
      uniqueId,
      vehicle: ensured.vehicle,
      ...(await status(ensured.device)),
    };
  }

  /** GET /tracker/me: creates the device lazily; never throws for configuration or Traccar problems. */
  async function getMe(user: UserType): Promise<TrackerMe> {
    const problem = configurationProblem();
    if (problem) return notConfigured(problem);
    try {
      return await describe(await ensureDevice(user));
    } catch (error) {
      deps.onError?.(error);
      return notConfigured(reasonFor(error));
    }
  }

  /** PUT /tracker/me/vehicle: moves the device to the vehicle's Traccar group and remembers the choice. */
  async function setVehicle(user: UserType, vehicle: Vehicle): Promise<TrackerMe> {
    const problem = configurationProblem();
    if (problem) return notConfigured(problem);
    try {
      const ensured = await ensureDevice(user);
      const groupId = groupIdForVehicle(vehicle, deps.groups);
      let device = ensured.device;
      if ((device.groupId ?? 0) !== groupId) {
        device = await requireApi().updateDevice({ ...device, groupId });
      }
      if (user.tracker && user.tracker.vehicle !== vehicle) {
        user.tracker.vehicle = vehicle;
        await user.save();
      }
      return await describe({ device, vehicle });
    } catch (error) {
      deps.onError?.(error);
      return notConfigured(reasonFor(error));
    }
  }

  /**
   * Admin: move any Traccar device to a vehicle's group (map icon) and keep the linked user's choice in sync.
   * Returns null when the device doesn't exist; throws when Traccar is not configured or fails.
   */
  async function setDeviceVehicle(deviceId: number, vehicle: Vehicle): Promise<{ deviceId: number; vehicle: Vehicle; groupId: number } | null> {
    const api = requireApi();
    const device = await api.getDevice(deviceId);
    if (!device) return null;
    const groupId = groupIdForVehicle(vehicle, deps.groups);
    if ((device.groupId ?? 0) !== groupId) await api.updateDevice({ ...device, groupId });
    await User.updateOne({ "tracker.deviceId": deviceId }, { $set: { "tracker.vehicle": vehicle } });
    return { deviceId, vehicle, groupId };
  }

  return { ensureDevice, getMe, setVehicle, setDeviceVehicle };
}

export type TrackerOnboarding = ReturnType<typeof createTrackerOnboarding>;
