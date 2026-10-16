import { describe, expect, test } from "bun:test";
import {
  buildDeepLink,
  buildQrUrl,
  deriveUniqueId,
  groupIdForVehicle,
  isConnected,
  mapStats,
  normalizeClientUrl,
  startOfDay,
  vehicleForGroupId,
  withVehicle,
  type VehicleGroups,
} from "./tracker-onboarding.helpers";

const SETTINGS = "accuracy=highest&distance=5&interval=5&heartbeat=30&buffer=true&wakelock=true&stop_detection=true";

describe("deriveUniqueId", () => {
  test("jh- plus the last 10 hex chars of the id, lowercase", () => {
    expect(deriveUniqueId("66F1A2B3C4D5E6F708192A3B")).toBe("jh-f708192a3b");
  });
});

describe("normalizeClientUrl", () => {
  test("keeps origin and path", () => {
    expect(normalizeClientUrl("http://tracker.jouwscouting.nl:5055")).toBe("http://tracker.jouwscouting.nl:5055/");
    expect(normalizeClientUrl(" https://example.nl/osmand ")).toBe("https://example.nl/osmand");
  });
  test("drops query and hash", () => {
    expect(normalizeClientUrl("http://example.nl:5055/?id=x#y")).toBe("http://example.nl:5055/");
  });
  test("missing or non-http values are null", () => {
    expect(normalizeClientUrl(undefined)).toBeNull();
    expect(normalizeClientUrl("")).toBeNull();
    expect(normalizeClientUrl("tracker.nl:5055")).toBeNull();
    expect(normalizeClientUrl("geen url")).toBeNull();
  });
});

describe("buildQrUrl / buildDeepLink", () => {
  test("QR = server url with id and settings as query", () => {
    expect(buildQrUrl("http://tracker.nl:5055/", "jh-0123456789")).toBe(`http://tracker.nl:5055/?id=jh-0123456789&${SETTINGS}`);
  });
  test("deep link encodes the server url in the url parameter", () => {
    expect(buildDeepLink("http://tracker.nl:5055/", "jh-0123456789")).toBe(
      `org.traccar.client://?url=http%3A%2F%2Ftracker.nl%3A5055%2F&id=jh-0123456789&${SETTINGS}`,
    );
  });
  test("deep link round-trips through URLSearchParams", () => {
    const link = buildDeepLink("https://example.nl/a b?", "jh-x");
    const params = new URLSearchParams(link.split("?").slice(1).join("?"));
    expect(params.get("url")).toBe("https://example.nl/a b?");
    expect(params.get("id")).toBe("jh-x");
  });
});

describe("vehicle groups", () => {
  const groups: VehicleGroups = { walking: 3, bike: 5, car: undefined, motorcycle: undefined };

  test("missing id maps to 0 (no group)", () => {
    expect(groupIdForVehicle("walking", groups)).toBe(3);
    expect(groupIdForVehicle("car", groups)).toBe(0);
  });
  test("reverse lookup", () => {
    expect(vehicleForGroupId(5, groups)).toBe("bike");
    expect(vehicleForGroupId(0, groups)).toBeUndefined();
    expect(vehicleForGroupId(99, groups)).toBeUndefined();
  });
});

describe("isConnected", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  test("within 5 minutes", () => {
    expect(isConnected("2026-10-17T11:55:00.000Z", now)).toBe(true);
    expect(isConnected(new Date("2026-10-17T11:59:30.000Z"), now)).toBe(true);
  });
  test("older, missing or invalid", () => {
    expect(isConnected("2026-10-17T11:54:59.000Z", now)).toBe(false);
    expect(isConnected(null, now)).toBe(false);
    expect(isConnected(undefined, now)).toBe(false);
    expect(isConnected("nope", now)).toBe(false);
  });
});

describe("startOfDay", () => {
  test("local midnight", () => {
    const start = startOfDay(new Date(2026, 9, 17, 14, 30));
    expect([start.getHours(), start.getMinutes(), start.getDate()]).toEqual([0, 0, 17]);
  });
});

describe("mapStats", () => {
  test("converts knots to km/h and rounds", () => {
    expect(
      mapStats({ lastUpdate: "2026-10-17T11:59:00Z", speed: 10, batteryLevel: 81.6, accuracy: 4.4, distanceTodayM: 12345.6 }),
    ).toEqual({ lastUpdate: "2026-10-17T11:59:00.000Z", speedKmh: 18.5, battery: 82, accuracyM: 4, distanceTodayM: 12346 });
  });
  test("omits missing and invalid fields", () => {
    expect(mapStats({ lastUpdate: null, speed: null, batteryLevel: "80", accuracy: 0 })).toEqual({});
    expect(mapStats({})).toEqual({});
  });
});

describe("withVehicle", () => {
  const groups = { walking: 4, bike: 5, car: 6, motorcycle: undefined };
  test("adds the vehicle of the device's group", () => {
    expect(withVehicle({ id: 1, groupId: 5, name: "a" }, groups)).toEqual({ id: 1, groupId: 5, name: "a", vehicle: "bike" });
  });
  test("null when the group is not a vehicle group or missing", () => {
    expect(withVehicle({ id: 2, groupId: 99 }, groups).vehicle).toBeNull();
    expect(withVehicle({ id: 3, groupId: 0 }, groups).vehicle).toBeNull();
  });
});
