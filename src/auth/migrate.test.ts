import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { User } from "../models/user.model";
import { ensurePasswordless, migratePasswordless } from "./migrate";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("migratePasswordless", () => {
  test("removes password fields, adds handles and passkeys, drops the email index; idempotent", async () => {
    const users = mongoose.connection.collection("users");
    await users.createIndex({ email: 1 }, { unique: true });
    await users.insertMany([
      { email: "a@test.nl", password: "$argon2id$x", name: "A", admin: true, requiresPasswordChange: false, passwordChangedAt: new Date() },
      { email: "b@test.nl", password: "$argon2id$y", name: "B", admin: false, requiresPasswordChange: true },
    ]);
    expect(await migratePasswordless(mongoose.connection)).toEqual({ cleaned: 2, handles: 2 });
    const docs = await users.find().toArray();
    for (const doc of docs) {
      expect(doc.email).toBeUndefined();
      expect(doc.password).toBeUndefined();
      expect(doc.requiresPasswordChange).toBeUndefined();
      expect(doc.webauthnUserId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(doc.passkeys).toEqual([]);
    }
    const indexes = (await users.indexes()).map((index) => index.name);
    expect(indexes).not.toContain("email_1");
    const handles = docs.map((doc) => doc.webauthnUserId);
    expect(await migratePasswordless(mongoose.connection)).toEqual({ cleaned: 0, handles: 0 });
    expect((await users.find().toArray()).map((doc) => doc.webauthnUserId)).toEqual(handles);
    expect(await User.countDocuments()).toBe(2);
  });
});

describe("ensurePasswordless (startup)", () => {
  test("migrates an unmigrated database and builds the passkey index without dropping other indexes", async () => {
    const users = mongoose.connection.collection("users");
    // As left by the password version: no passkey index yet
    await users.drop().catch(() => undefined);
    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ name: 1 });
    await users.insertOne({ email: "a@test.nl", password: "$argon2id$x", name: "A", admin: true });
    expect(await ensurePasswordless(mongoose.connection)).toEqual({ cleaned: 1, handles: 1 });
    const indexes = await users.indexes();
    const names = indexes.map((index) => index.name);
    expect(names).not.toContain("email_1");
    expect(names).toContain("name_1");
    const passkeyIndex = indexes.find((index) => index.name === "passkeys.credentialId_1");
    expect(passkeyIndex?.unique).toBe(true);
    expect(passkeyIndex?.partialFilterExpression).toEqual({ "passkeys.credentialId": { $exists: true } });
    // Without the e-mail index several accounts (no e-mail) can be created
    await User.create({ name: "B" });
    await User.create({ name: "C" });
    expect(await User.countDocuments()).toBe(3);
    expect(await ensurePasswordless(mongoose.connection)).toEqual({ cleaned: 0, handles: 0 });
  });

  test("works on a fresh database without a users collection", async () => {
    await mongoose.connection.collection("users").drop().catch(() => undefined);
    expect(await ensurePasswordless(mongoose.connection)).toEqual({ cleaned: 0, handles: 0 });
  });
});
