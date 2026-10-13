import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { PairingCode } from "../models/pairing-code.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import {
  addDevice,
  createPairingCode,
  generatePairingCode,
  hashPairingCode,
  listDevices,
  MAX_DEVICES,
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_TTL_MS,
  redeemPairingCode,
  removeDevice,
} from "./pairing.service";
import { signDeviceToken } from "./access-token";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const createUser = () => User.create({ name: "Hunter" });

describe("pairing codes", () => {
  test("generate: 8 chars from the unambiguous alphabet", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(8);
    for (const char of code) expect(PAIRING_ALPHABET).toContain(char);
    expect(generatePairingCode(() => 0)).toBe("AAAAAAAA");
  });

  test("normalize: case, spaces and dashes don't matter", () => {
    expect(normalizePairingCode(" abcd-2345 ")).toBe("ABCD2345");
  });

  test("only the hash is stored", async () => {
    const user = await createUser();
    const { code, expiresAt } = await createPairingCode(user._id, new Date("2026-10-17T10:00:00Z"));
    expect(expiresAt.toISOString()).toBe(new Date(Date.parse("2026-10-17T10:00:00Z") + PAIRING_CODE_TTL_MS).toISOString());
    const stored = await PairingCode.findOne({}).lean();
    expect(stored?.codeHash).toBe(hashPairingCode(code));
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  test("redeem returns the user once; a second redeem fails", async () => {
    const user = await createUser();
    const { code } = await createPairingCode(user._id);
    const redeemed = await redeemPairingCode(code.toLowerCase());
    expect(redeemed._id.toString()).toBe(user._id.toString());
    await expect(redeemPairingCode(code)).rejects.toBeInstanceOf(ServiceError);
  });

  test("an expired code fails", async () => {
    const user = await createUser();
    const created = new Date("2026-10-17T10:00:00Z");
    const { code } = await createPairingCode(user._id, created);
    const later = new Date(created.getTime() + PAIRING_CODE_TTL_MS + 1);
    await expect(redeemPairingCode(code, later)).rejects.toThrow("ongeldig of verlopen");
  });

  test("an unknown code fails with 400", async () => {
    try {
      await redeemPairingCode("ZZZZZZZZ");
      throw new Error("should fail");
    } catch (error) {
      expect((error as ServiceError).status).toBe(400);
    }
  });
});

describe("devices", () => {
  test("add, list and remove", async () => {
    const user = await createUser();
    const device = await addDevice(user, "Pixel 8");
    expect(listDevices(user).map((d) => d.name)).toEqual(["Pixel 8"]);
    expect(await removeDevice(user, device.id)).toBe(true);
    expect(await removeDevice(user, device.id)).toBe(false);
    expect((await User.findById(user._id))?.devices).toHaveLength(0);
  });

  test("keeps at most MAX_DEVICES, dropping the least recently seen", async () => {
    const user = await createUser();
    const first = await addDevice(user, "oud", new Date("2026-10-01T00:00:00Z"));
    for (let i = 1; i < MAX_DEVICES; i++) await addDevice(user, `toestel ${i}`, new Date(`2026-10-0${Math.min(i + 1, 9)}T00:00:00Z`));
    await addDevice(user, "nieuw", new Date("2026-10-11T00:00:00Z"));
    const ids = listDevices(user).map((d) => d.id);
    expect(ids).toHaveLength(MAX_DEVICES);
    expect(ids).not.toContain(first.id);
    expect(listDevices(user).map((d) => d.name)).toContain("nieuw");
    expect((await User.findById(user._id))?.devices.map((d) => d.id)).toEqual(ids);
  });

  test("two concurrent pairings on separately loaded copies of the user both keep their device", async () => {
    const created = await createUser();
    const [copyA, copyB] = await Promise.all([User.findById(created._id), User.findById(created._id)]);
    const [a, b] = await Promise.all([addDevice(copyA!, "A"), addDevice(copyB!, "B")]);
    const stored = (await User.findById(created._id))?.devices.map((d) => d.id);
    expect(stored).toHaveLength(2);
    expect(stored).toContain(a.id);
    expect(stored).toContain(b.id);
  });

  test("device token carries did and kind and expires in 30 days", async () => {
    const user = await createUser();
    const token = signDeviceToken(user, "dev-1");
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { did: string; kind: string; exp: number; iat: number };
    expect(decoded.did).toBe("dev-1");
    expect(decoded.kind).toBe("device");
    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
  });
});
