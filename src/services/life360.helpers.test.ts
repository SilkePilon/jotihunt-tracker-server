import { describe, expect, test } from "bun:test";
import { DEVICE_FIX_ISO, FIX_ISO, FIX_TIME, rawDeviceLocation, rawMember } from "../test/life360-fixtures";
import {
  ACCURACY_TO_METRES,
  DRIVING_SPEED_MS,
  latestByUser,
  mergeLocations,
  parseDeviceLocations,
  life360ConfigFromEnv,
  life360Time,
  LIVE_WINDOW_MS,
  liveCount,
  memberName,
  parseMembers,
  SPEED_TO_KMH,
  type Life360Location,
  type Life360Member,
} from "./life360.helpers";

describe("parseMembers", () => {
  test("a sharing member: numbers from strings, accuracy in metres, timestamp as ISO, the avatar behind our own route", () => {
    expect(parseMembers([rawMember("m1", "Silke", "Pilon", { location: { speed: "13.4", isDriving: "1", charge: "1" } })])).toEqual([
      {
        member: {
          id: "m1",
          name: "Silke P.",
          initials: "SP",
          avatarUrl: "/life360/avatar/m1",
          location: { lat: 52.0907, lon: 5.1214, accuracyM: 15, at: FIX_ISO, driving: true, speedKmh: 48, battery: 84, charging: true },
        },
        avatarSource: "https://www.life360.com/img/user_images/m1.jpg",
        sharing: true,
      },
    ]);
  });

  test("never carries addresses, place names, e-mail addresses, phone numbers or Life360 URLs", () => {
    const json = JSON.stringify(parseMembers([rawMember("m1", "Silke", "Pilon")]).map((parsed) => parsed.member));
    for (const secret of ["Dorpsstraat", "Scherpenzeel", "Thuis", "@example.nl", "+31612345678", "life360.com"]) expect(json).not.toContain(secret);
  });

  test("not sharing or no location: location null, the member is still listed", () => {
    const [notSharing, noLocation] = parseMembers([rawMember("m1", "Anna", "B", { shareLocation: "0" }), rawMember("m2", "Bram", "C", { location: null })]);
    expect(notSharing.member.location).toBeNull();
    expect(noLocation.member.location).toBeNull();
    expect(notSharing.member.name).toBe("Anna B.");
    expect([notSharing.sharing, noLocation.sharing]).toEqual([false, true]);
  });

  test("unknown values: battery -1 and negative speed are null, missing accuracy is 0, timestamps in ms are accepted", () => {
    const [parsed] = parseMembers([rawMember("m1", "Silke", "Pilon", { location: { battery: "-1", speed: "-1", accuracy: undefined, timestamp: String(FIX_TIME * 1000) } })]);
    expect(parsed.member.location).toEqual({ lat: 52.0907, lon: 5.1214, accuracyM: 0, at: FIX_ISO, driving: false, speedKmh: null, battery: null, charging: false });
  });

  test("an unusable fix counts as no fix", () => {
    const members = parseMembers([
      rawMember("a", "A", "", { location: { latitude: "abc" } }),
      rawMember("b", "B", "", { location: { latitude: "95" } }),
      rawMember("c", "C", "", { location: { latitude: "0", longitude: "0" } }),
      rawMember("d", "D", "", { location: { timestamp: "" } }),
    ]);
    expect(members.map((parsed) => parsed.member.location)).toEqual([null, null, null, null]);
  });

  test("avatars: none or non-https → no avatar; ids are URL-encoded", () => {
    const [none, http, odd] = parseMembers([
      rawMember("m1", "A", "", { avatar: null }),
      rawMember("m2", "B", "", { avatar: "http://www.life360.com/x.jpg" }),
      rawMember("a/b", "C", "", { avatar: "https://www.life360.com/c.jpg" }),
    ]);
    expect([none.member.avatarUrl, none.avatarSource]).toEqual([null, null]);
    expect([http.member.avatarUrl, http.avatarSource]).toEqual([null, null]);
    expect(odd.member.avatarUrl).toBe("/life360/avatar/a%2Fb");
  });

  test("members without id are skipped; anything but an array gives no members", () => {
    expect(parseMembers([{ firstName: "Geen id" }, null, "x", rawMember("m1", "A", "")]).map((parsed) => parsed.member.id)).toEqual(["m1"]);
    expect(parseMembers({ members: [] })).toEqual([]);
    expect(parseMembers(undefined)).toEqual([]);
  });
});

describe("parseDeviceLocations (v5)", () => {
  test("one position per device: owner id, numbers as sent, accuracy in metres, lastObserved as the fix time", () => {
    expect(parseDeviceLocations([rawDeviceLocation("m1", { speed: 13.4, batteryCharging: true })])).toEqual([
      { userId: "m1", location: { lat: 52.1, lon: 5.2, accuracyM: 20, at: DEVICE_FIX_ISO, driving: true, speedKmh: 48, battery: 77, charging: true } },
    ]);
  });

  test("accepts the whole answer ({data:{items}}) too; anything else gives nothing", () => {
    expect(parseDeviceLocations({ data: { items: [rawDeviceLocation("m1")] } }).map((entry) => entry.userId)).toEqual(["m1"]);
    expect(parseDeviceLocations({ data: {} })).toEqual([]);
    expect(parseDeviceLocations(undefined)).toEqual([]);
  });

  test("driving: inTransit, or a speed of at least DRIVING_SPEED_MS; negative speed and battery are unknown", () => {
    const [transit, fast, slow, unknown] = parseDeviceLocations([
      rawDeviceLocation("a", { inTransit: true, speed: 0 }),
      rawDeviceLocation("b", { speed: DRIVING_SPEED_MS }),
      rawDeviceLocation("c", { speed: DRIVING_SPEED_MS - 0.1 }),
      rawDeviceLocation("d", { speed: -1, batteryLevel: -1, accuracy: undefined }),
    ]);
    expect([transit.location.driving, fast.location.driving, slow.location.driving, unknown.location.driving]).toEqual([true, true, false, false]);
    expect(unknown.location).toMatchObject({ speedKmh: null, battery: null, accuracyM: 0 });
  });

  test("items without an owner or a usable fix are skipped; only position fields come out", () => {
    const list = parseDeviceLocations([
      rawDeviceLocation("a", { owners: [] }),
      rawDeviceLocation("b", { latitude: "abc" }),
      rawDeviceLocation("c", { latitude: 0, longitude: 0 }),
      rawDeviceLocation("d", { lastObserved: "gisteren" }),
      rawDeviceLocation("e", { longitude: 181 }),
      null,
      rawDeviceLocation("ok"),
    ]);
    expect(list.map((entry) => entry.userId)).toEqual(["ok"]);
    expect(JSON.stringify(list)).not.toContain("android");
  });

  test("only phones: a tile or other tracker is skipped; an item without type is kept", () => {
    const list = parseDeviceLocations([
      rawDeviceLocation("tile", { type: "tile", provider: "tile" }),
      rawDeviceLocation("jiobit", { type: "jiobit" }),
      rawDeviceLocation("phone"),
      rawDeviceLocation("untyped", { type: undefined }),
    ]);
    expect(list.map((entry) => entry.userId)).toEqual(["phone", "untyped"]);
  });

  test("latestByUser: with several devices the most recent lastObserved wins", () => {
    const byUser = latestByUser(
      parseDeviceLocations([
        rawDeviceLocation("m1", { latitude: 51 }),
        rawDeviceLocation("m1", { latitude: 53, lastObserved: "2026-10-15T12:05:00.000Z" }),
        rawDeviceLocation("m1", { latitude: 54, lastObserved: "2026-10-15T11:00:00.000Z" }),
        rawDeviceLocation("m2"),
      ]),
    );
    expect([...byUser.keys()]).toEqual(["m1", "m2"]);
    expect(byUser.get("m1")!.lat).toBe(53);
  });
});

describe("mergeLocations", () => {
  const fix = (lat: number, at: string): Life360Location => ({ lat, lon: 5, accuracyM: 10, at, driving: false, speedKmh: null, battery: null, charging: false });
  const roster = parseMembers([
    rawMember("v5", "A", ""),
    rawMember("v3", "B", ""),
    rawMember("carry", "C", "", { location: null }),
    rawMember("off", "D", "", { shareLocation: "0" }),
    rawMember("none", "E", "", { location: null }),
  ]);

  test("v5 position first, else the v3 position, else the last known while sharing; not sharing: null; members only from the roster", () => {
    const devices = new Map([
      ["v5", fix(1, DEVICE_FIX_ISO)],
      ["off", fix(2, DEVICE_FIX_ISO)],
      ["stranger", fix(3, DEVICE_FIX_ISO)],
    ]);
    const previous = new Map([["carry", fix(4, FIX_ISO)]]);
    const merged = mergeLocations(roster, devices, previous);
    expect(merged.map((member) => [member.id, member.location?.lat ?? null])).toEqual([
      ["v5", 1],
      ["v3", 52.0907],
      ["carry", 4],
      ["off", null],
      ["none", null],
    ]);
    expect(merged[0]).toMatchObject({ name: "A", avatarUrl: "/life360/avatar/v5" });
  });

  test("a v3 position older than the last known one does not move the member back in time", () => {
    const newer = fix(9, DEVICE_FIX_ISO);
    expect(mergeLocations(roster, new Map(), new Map([["v3", newer]]))[1].location).toEqual(newer);
    const older = fix(9, "2026-10-15T11:00:00.000Z");
    expect(mergeLocations(roster, new Map(), new Map([["v3", older]]))[1].location!.lat).toBe(52.0907);
  });

  test("a v5 position older than the last known one does not replace it (an older phone fix or a tracker)", () => {
    const known = fix(7, DEVICE_FIX_ISO);
    const olderV5 = new Map([["v5", fix(8, "2026-10-15T11:00:00.000Z")]]);
    expect(mergeLocations(roster, olderV5, new Map([["v5", known]]))[0].location).toEqual(known);
    const sameAge = new Map([["v5", fix(8, DEVICE_FIX_ISO)]]);
    expect(mergeLocations(roster, sameAge, new Map([["v5", known]]))[0].location!.lat).toBe(8);
  });
});

describe("memberName", () => {
  test("first name + initial of the last name; last name empty → first name; nothing → Onbekend", () => {
    expect(memberName("Bram", "de Vries")).toEqual({ name: "Bram D.", initials: "BD" });
    expect(memberName("Anna", "")).toEqual({ name: "Anna", initials: "A" });
    expect(memberName(" silke ", null)).toEqual({ name: "silke", initials: "S" });
    expect(memberName(null, undefined)).toEqual({ name: "Onbekend", initials: "?" });
  });
});

describe("life360Time", () => {
  test("Unix seconds (string or number) or milliseconds → ISO; anything else → null", () => {
    expect(life360Time(String(FIX_TIME))).toBe(FIX_ISO);
    expect(life360Time(FIX_TIME)).toBe(FIX_ISO);
    expect(life360Time(String(FIX_TIME * 1000))).toBe(FIX_ISO);
    for (const value of ["0", "-5", "abc", "", null, undefined, {}]) expect(life360Time(value)).toBeNull();
  });
});

describe("liveCount", () => {
  test("members with a fix of at most 15 minutes old", () => {
    const member = (at: string | null): Life360Member => ({
      id: at ?? "none",
      name: "X",
      initials: "X",
      avatarUrl: null,
      location: at ? { lat: 52, lon: 5, accuracyM: 10, at, driving: false, speedKmh: null, battery: null, charging: false } : null,
    });
    const now = new Date(Date.parse(FIX_ISO) + LIVE_WINDOW_MS);
    expect(liveCount([member(FIX_ISO), member(new Date(Date.parse(FIX_ISO) - 1000).toISOString()), member(null)], now)).toBe(1);
  });
});

test("unit constants (v3 accuracy: feet per ha-life360, real check pending; speed m/s; driving from 18 km/h)", () => {
  expect(ACCURACY_TO_METRES).toBe(0.3048);
  expect(DRIVING_SPEED_MS).toBe(5);
  expect(SPEED_TO_KMH).toBe(3.6);
  expect(LIVE_WINDOW_MS).toBe(15 * 60 * 1000);
});

describe("life360ConfigFromEnv", () => {
  test("off without a key (no warning), off with a bad key (warning), on with 32 bytes base64", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(life360ConfigFromEnv({}, warn)).toBeNull();
    expect(life360ConfigFromEnv({ LIFE360_SESSION_KEY: "  " }, warn)).toBeNull();
    expect(warnings).toEqual([]);
    expect(life360ConfigFromEnv({ LIFE360_SESSION_KEY: "kort" }, warn)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("LIFE360_SESSION_KEY");
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(life360ConfigFromEnv({ LIFE360_SESSION_KEY: ` ${key} ` }, warn)).toEqual({ sessionKey: key });
  });
});
