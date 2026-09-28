import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import type { NewDevice, TraccarApi, TraccarDeviceDto, TraccarPositionDto } from "./traccar-api";
import { deriveUniqueId, type VehicleGroups } from "./tracker-onboarding.helpers";
import { createTrackerOnboarding } from "./tracker-onboarding.service";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const GROUPS: VehicleGroups = { walking: 3, bike: 5, car: 2, motorcycle: undefined };
const CLIENT_URL = "http://tracker.test:5055";
const SETTINGS = "accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true";

/** In-memory Traccar: devices by id, positions by id, one distance per device; records every call. */
function fakeTraccar() {
  const devices = new Map<number, TraccarDeviceDto>();
  const positions = new Map<number, TraccarPositionDto>();
  const distances = new Map<number, number>();
  const calls: string[] = [];
  let nextId = 100;
  let down = false;
  const guard = () => {
    if (down) throw new Error("connect ECONNREFUSED");
  };
  const api: TraccarApi = {
    async findDevice(uniqueId) {
      calls.push(`find ${uniqueId}`);
      guard();
      return [...devices.values()].find((device) => device.uniqueId === uniqueId) ?? null;
    },
    async createDevice(input: NewDevice) {
      calls.push(`create ${input.name} ${input.uniqueId} ${input.groupId}`);
      guard();
      const device: TraccarDeviceDto = { id: nextId++, ...input, positionId: null, lastUpdate: null, status: "unknown" };
      devices.set(device.id, device);
      return device;
    },
    async updateDevice(device) {
      calls.push(`update ${device.id} ${device.groupId}`);
      guard();
      devices.set(device.id, device);
      return device;
    },
    async getPosition(positionId) {
      calls.push(`position ${positionId}`);
      guard();
      return positions.get(positionId) ?? null;
    },
    async getDistance(deviceId, from, to) {
      calls.push(`distance ${deviceId} ${from.toISOString()} ${to.toISOString()}`);
      guard();
      if (!distances.has(deviceId)) throw new Error("report failed");
      return distances.get(deviceId)!;
    },
  };
  return {
    api,
    devices,
    positions,
    distances,
    calls,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

async function makeUser() {
  return User.create({ email: "hunter@local.test", password: "x", name: "Hunter Een" });
}

/** `clientUrl: null` simulates an unset TRACCAR_CLIENT_URL. */
function service(traccar: ReturnType<typeof fakeTraccar> | null, clientUrl: string | null = CLIENT_URL) {
  const errors: unknown[] = [];
  const onboarding = createTrackerOnboarding({
    api: traccar?.api ?? null,
    clientUrl: clientUrl ?? undefined,
    groups: GROUPS,
    now: () => NOW,
    onError: (error) => errors.push(error),
  });
  return { onboarding, errors };
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("configuration", () => {
  test("missing, invalid client url and missing API give configured:false with a reason", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    expect(await service(traccar, null).onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_missing", connected: false });
    expect(await service(traccar, "  ").onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_missing", connected: false });
    expect(await service(traccar, "tracker.test:5055").onboarding.getMe(user)).toEqual({ configured: false, reason: "client_url_invalid", connected: false });
    expect(await service(null).onboarding.getMe(user)).toEqual({ configured: false, reason: "api_missing", connected: false });
    expect(await service(null).onboarding.setVehicle(user, "bike")).toEqual({ configured: false, reason: "api_missing", connected: false });
    expect(traccar.calls).toEqual([]);
  });

  test("Traccar down gives configured:false 'unreachable' and reports the error", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    traccar.setDown(true);
    const { onboarding, errors } = service(traccar);
    expect(await onboarding.getMe(user)).toEqual({ configured: false, reason: "unreachable", connected: false });
    expect(await onboarding.setVehicle(user, "car")).toEqual({ configured: false, reason: "unreachable", connected: false });
    expect(errors).toHaveLength(2);
  });

  test("Traccar rejecting the group (bad GROUP_*_ID) gives configured:false 'group_invalid', not 'unreachable'", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    // Simulate the axios error Traccar returns for an unknown/foreign-key-violating groupId.
    traccar.api.createDevice = async () => {
      throw {
        isAxiosError: true,
        message: "Request failed with status code 400",
        config: { method: "post", url: "http://traccar.test/api/devices" },
        response: { status: 400, data: { message: "foreign key group_id" } },
      };
    };
    const { onboarding, errors } = service(traccar);
    expect(await onboarding.getMe(user)).toEqual({ configured: false, reason: "group_invalid", connected: false });
    expect(errors).toHaveLength(1);
  });
});

describe("getMe", () => {
  test("creates the device lazily in the walking group and stores it on the user", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    const me = await service(traccar).onboarding.getMe(user);

    expect(me).toEqual({
      configured: true,
      qrUrl: `http://tracker.test:5055/?id=${uniqueId}&${SETTINGS}`,
      deepLink: `org.traccar.client://?url=http%3A%2F%2Ftracker.test%3A5055%2F&id=${uniqueId}&${SETTINGS}`,
      uniqueId,
      vehicle: "walking",
      connected: false,
      stats: {},
    });
    expect(traccar.calls.slice(0, 2)).toEqual([`find ${uniqueId}`, `create Hunter Een ${uniqueId} 3`]);
    const stored = await User.findById(user._id).lean();
    expect(stored?.tracker).toEqual({ deviceId: 100, uniqueId, vehicle: "walking" });
  });

  test("recovers when a concurrent request created the device first (duplicate uniqueId)", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    const originalCreate = traccar.api.createDevice.bind(traccar.api);
    // Simulate the race: the device gets created by "someone else", then our create call fails
    traccar.api.createDevice = async (input) => {
      await originalCreate(input);
      throw new Error("duplicate uniqueId");
    };
    const me = await service(traccar).onboarding.getMe(user);

    expect(me).toMatchObject({ configured: true, uniqueId, connected: false });
    expect(traccar.devices.size).toBe(1);
    const stored = await User.findById(user._id).lean();
    expect(stored?.tracker?.deviceId).toBe(100);
  });

  test("reuses an existing device and does not create a second one", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.getMe(user);
    expect(traccar.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(traccar.devices.size).toBe(1);
  });

  test("adopts a device that already existed in Traccar, taking the vehicle from its group", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Oud", uniqueId, groupId: 5, positionId: null, lastUpdate: null });
    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({ configured: true, vehicle: "bike" });
    expect(traccar.calls.some((call) => call.startsWith("create"))).toBe(false);
    expect((await User.findById(user._id).lean())?.tracker).toEqual({ deviceId: 7, uniqueId, vehicle: "bike" });
  });

  test("recreates the device when it was deleted in Traccar, keeping the chosen vehicle", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.setVehicle(user, "car");
    traccar.devices.clear();

    const me = await onboarding.getMe(user);
    expect(me).toMatchObject({ configured: true, vehicle: "car" });
    expect(traccar.calls.filter((call) => call.startsWith("create"))).toEqual([
      `create Hunter Een ${deriveUniqueId(user._id.toString())} 3`,
      `create Hunter Een ${deriveUniqueId(user._id.toString())} 2`,
    ]);
    expect((await User.findById(user._id).lean())?.tracker?.deviceId).toBe(101);
  });

  test("connected with stats when the device reported within 5 minutes", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Hunter Een", uniqueId, groupId: 3, positionId: 70, lastUpdate: "2026-10-17T11:58:00.000Z" });
    traccar.positions.set(70, { id: 70, deviceId: 7, speed: 2.5, accuracy: 6.2, attributes: { batteryLevel: 76 } });
    traccar.distances.set(7, 4321.4);

    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({
      configured: true,
      connected: true,
      stats: { lastUpdate: "2026-10-17T11:58:00.000Z", speedKmh: 4.6, battery: 76, accuracyM: 6, distanceTodayM: 4321 },
    });
    const from = new Date(NOW);
    from.setHours(0, 0, 0, 0);
    expect(traccar.calls).toContain(`distance 7 ${from.toISOString()} ${NOW.toISOString()}`);
  });

  test("not connected after 5 minutes; a failing summary report only drops the distance", async () => {
    const user = await makeUser();
    const uniqueId = deriveUniqueId(user._id.toString());
    const traccar = fakeTraccar();
    traccar.devices.set(7, { id: 7, name: "Hunter Een", uniqueId, groupId: 3, positionId: 70, lastUpdate: "2026-10-17T11:54:00.000Z" });
    traccar.positions.set(70, { id: 70, deviceId: 7, speed: 0, accuracy: 12 });

    const me = await service(traccar).onboarding.getMe(user);
    expect(me).toMatchObject({ connected: false, stats: { lastUpdate: "2026-10-17T11:54:00.000Z", speedKmh: 0, accuracyM: 12 } });
    expect(me.configured && me.stats.distanceTodayM).toBeUndefined();
  });
});

describe("setVehicle", () => {
  test("PUTs the full device with the new group and stores the vehicle", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);

    const me = await onboarding.setVehicle(user, "bike");
    expect(me).toMatchObject({ configured: true, vehicle: "bike" });
    expect(traccar.calls).toContain("update 100 5");
    expect(traccar.devices.get(100)).toMatchObject({ id: 100, name: "Hunter Een", status: "unknown", groupId: 5 });
    expect((await User.findById(user._id).lean())?.tracker?.vehicle).toBe("bike");
  });

  test("vehicle without a configured group moves the device out of its group (groupId 0)", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.setVehicle(user, "motorcycle");
    expect(traccar.devices.get(100)?.groupId).toBe(0);
  });

  test("same group: no PUT", async () => {
    const user = await makeUser();
    const traccar = fakeTraccar();
    const { onboarding } = service(traccar);
    await onboarding.getMe(user);
    await onboarding.setVehicle(user, "walking");
    expect(traccar.calls.some((call) => call.startsWith("update"))).toBe(false);
  });
});

describe("User.tracker", () => {
  test("rejects an unknown vehicle", async () => {
    const user = await makeUser();
    user.set("tracker", { deviceId: 1, uniqueId: "jh-1", vehicle: "boat" });
    await expect(user.save()).rejects.toThrow();
  });

  test("is left out when not set", async () => {
    const user = await makeUser();
    expect(user.toJSON().tracker).toBeUndefined();
    expect(user.toJSON().password).toBeUndefined();
  });
});
