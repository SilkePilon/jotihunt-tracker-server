import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { setDemoModeFlag } from "../demo/demo-mode";
import { setAuthConnection } from "./auth-db";
import { createAccount, updateAccounts } from "./user-store";
import { publicUser } from "./public-user";

const REAL_DB = "jotihunt-test-real";
let real: mongoose.Connection;

beforeAll(async () => {
  await connectTestDb();
  real = await mongoose.createConnection(process.env.MONGO_URI_TEST?.replace(/\/[^/]*$/, `/${REAL_DB}`) ?? `mongodb://localhost:27017/${REAL_DB}`).asPromise();
  await real.dropDatabase();
});
beforeEach(async () => {
  await clearTestDb();
  await real.collection("users").deleteMany({});
  setDemoModeFlag(false);
  setAuthConnection(null);
});
afterAll(async () => {
  setDemoModeFlag(false);
  setAuthConnection(null);
  await real.dropDatabase();
  await real.close();
  await disconnectTestDb();
});

const passkey = { credentialId: "cred-1", publicKey: Buffer.from("pk"), counter: 0, transports: ["internal"], name: "Chrome op Android" };

describe("createAccount", () => {
  test("creates a user with a passkey, webauthn id and timestamps", async () => {
    const user = await createAccount({ name: "Jesse", passkey });
    expect(user.name).toBe("Jesse");
    expect(user.admin).toBe(false);
    expect(user.webauthnUserId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user.passkeys).toHaveLength(1);
    expect(user.passkeys[0].credentialId).toBe("cred-1");
    expect(user.lastActiveAt).toBeInstanceOf(Date);
  });

  test("outside demo mode only the default database gets the user", async () => {
    setAuthConnection(real);
    await createAccount({ name: "Jesse" });
    expect(await real.collection("users").countDocuments()).toBe(0);
  });

  test("in demo mode the user is mirrored to the real database with the same id", async () => {
    setAuthConnection(real);
    setDemoModeFlag(true);
    const user = await createAccount({ name: "Jesse", passkey });
    const mirrored = await real.collection("users").findOne({ _id: user._id });
    expect(mirrored?.name).toBe("Jesse");
    expect(mirrored?.passkeys).toHaveLength(1);
  });

  test("a passkey credential id is unique across users", async () => {
    await createAccount({ name: "A", passkey });
    await expect(createAccount({ name: "B", passkey })).rejects.toMatchObject({ code: 11000 });
  });

  test("users without passkeys never clash on the passkey index", async () => {
    await createAccount({ name: "A" });
    await createAccount({ name: "B" });
    expect(await User.countDocuments()).toBe(2);
  });
});

describe("updateAccounts", () => {
  test("in demo mode updates both databases", async () => {
    setAuthConnection(real);
    setDemoModeFlag(true);
    const user = await createAccount({ name: "Jesse" });
    await updateAccounts({ _id: user._id }, { $set: { name: "Jes" } });
    expect((await User.findById(user._id))?.name).toBe("Jes");
    expect((await real.collection("users").findOne({ _id: user._id }))?.name).toBe("Jes");
  });
});

describe("publicUser", () => {
  test("only sends id, name, admin, tour version and passkey count", async () => {
    const user = await createAccount({ name: "Jesse", passkey });
    expect(publicUser(user)).toEqual({ _id: String(user._id), name: "Jesse", admin: false, tutorialVersion: 0, passkeyCount: 1 });
  });

  test("toJSON hides passkeys and the webauthn id", async () => {
    const user = await createAccount({ name: "Jesse", passkey });
    const json = user.toJSON() as Record<string, unknown>;
    expect(json.passkeys).toBeUndefined();
    expect(json.webauthnUserId).toBeUndefined();
    expect(json.passkeyCount).toBe(1);
  });
});
