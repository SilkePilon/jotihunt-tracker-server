import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { createAccount, setLiveUsersConnection, updateAccounts } from "./user-store";
import { publicUser } from "./public-user";

/** The live edition's database (master copy of the users) while the default connection serves an archive on another database */
const CONTROL_DB = "jotihunt-test-control";
let control: mongoose.Connection;

beforeAll(async () => {
  await connectTestDb();
  control = await mongoose.createConnection(process.env.MONGO_URI_TEST?.replace(/\/[^/]*$/, `/${CONTROL_DB}`) ?? `mongodb://localhost:27017/${CONTROL_DB}`).asPromise();
  await control.dropDatabase();
});
beforeEach(async () => {
  await clearTestDb();
  await control.collection("users").deleteMany({});
  setLiveUsersConnection(undefined);
});
afterAll(async () => {
  setLiveUsersConnection(undefined);
  await control.dropDatabase();
  await control.close();
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

  test("when the live edition is shown the user is written once", async () => {
    const sameDb = await mongoose.createConnection(process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test").asPromise();
    try {
      expect(sameDb.name).toBe(mongoose.connection.name);
      setLiveUsersConnection(sameDb);
      await createAccount({ name: "Jesse" });
      expect(await User.countDocuments()).toBe(1);
      expect(await control.collection("users").countDocuments()).toBe(0);
    } finally {
      setLiveUsersConnection(undefined);
      await sameDb.close();
    }
  });

  test("when an archive on another database is shown the user is mirrored to the live database with the same id", async () => {
    setLiveUsersConnection(control);
    const user = await createAccount({ name: "Jesse", passkey });
    const mirrored = await control.collection("users").findOne({ _id: user._id });
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
  test("in an archive updates both databases", async () => {
    setLiveUsersConnection(control);
    const user = await createAccount({ name: "Jesse" });
    await updateAccounts({ _id: user._id }, { $set: { name: "Jes" } });
    expect((await User.findById(user._id))?.name).toBe("Jes");
    expect((await control.collection("users").findOne({ _id: user._id }))?.name).toBe("Jes");
  });

  test("in an archive leaves the live database alone when the shown one matched nothing", async () => {
    setLiveUsersConnection(control);
    const user = await createAccount({ name: "Jesse" });
    // Only the live database still has the old name, so only it would match
    await User.updateOne({ _id: user._id }, { $set: { name: "Other" } });
    expect(await updateAccounts({ _id: user._id, name: "Jesse" }, { $set: { name: "Jes" } })).toBe(false);
    expect((await control.collection("users").findOne({ _id: user._id }))?.name).toBe("Jesse");
    expect(await updateAccounts({ _id: user._id }, { $set: { name: "Jes" } })).toBe(true);
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
