import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { User } from "../models/user.model";
import { migratePasswordless } from "./migrate";

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
