import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import verifyToken from "../middleware/auth.middleware";
import { User, type UserType } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { sessions } from "./models";
import {
  cacheSession,
  clearSessionCache,
  getCachedSession,
  SESSION_CACHE_TTL_MS,
  sessionCacheEpoch,
  sessionCacheSize,
} from "./session-cache";
import { createSession, revokeSession, revokeUserSessions } from "./sessions";
import { createAccount, deleteAccounts, updateAccounts } from "./user-store";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clearSessionCache();
});
afterAll(disconnectTestDb);

/** Run verifyToken like Express would: the user it set, or the status it answered with. */
async function authenticate(token: string): Promise<{ status: number; user?: UserType }> {
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
  let status = 200;
  const res = {
    locals: {},
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  let passed = false;
  await verifyToken(req, res, (() => {
    passed = true;
  }) as NextFunction);
  return passed ? { status, user: req.user } : { status };
}

async function login(name = "Jesse") {
  const user = await createAccount({ name });
  const { token, sessionId } = await createSession(user._id, { label: "Test", via: "passkey" });
  return { user, token, sessionId };
}

/** A write Mongoose doesn't see (like another server process would make): only the TTL bounds it. */
const rawRename = (id: unknown, name: string) => User.collection.updateOne({ _id: id as mongoose.Types.ObjectId }, { $set: { name } });

describe("session cache", () => {
  test("a second request is served from the cache", async () => {
    const { token } = await login();
    expect((await authenticate(token)).user?.name).toBe("Jesse");
    expect(sessionCacheSize()).toBe(1);
    await rawRename((await User.findOne())!._id, "Raw");
    expect((await authenticate(token)).user?.name).toBe("Jesse");
  });

  test("every request gets its own document: changes to req.user don't leak into the next request", async () => {
    const { token } = await login();
    const first = (await authenticate(token)).user!;
    first.name = "Changed";
    first.devices.push({ id: "p1", name: "Pixel", createdAt: new Date() });
    const second = (await authenticate(token)).user!;
    expect(second.name).toBe("Jesse");
    expect(second.devices).toHaveLength(0);
  });

  test("saving req.user updates the next request and leaves the read state alone", async () => {
    const { user, token } = await login();
    await User.updateOne({ _id: user._id }, { $set: { readArticles: [1, 2] } });
    const first = (await authenticate(token)).user!;
    first.name = "Saved";
    await first.save();
    expect((await authenticate(token)).user?.name).toBe("Saved");
    expect((await User.findById(user._id).lean())?.readArticles).toEqual([1, 2]);
  });

  test("revokeSession and revokeUserSessions log out at once", async () => {
    const a = await login();
    await authenticate(a.token);
    await revokeSession(a.sessionId);
    expect((await authenticate(a.token)).status).toBe(401);

    const b = await login("Noor");
    const second = await createSession(b.user._id, { label: "Tweede", via: "passkey" });
    await authenticate(b.token);
    await authenticate(second.token);
    await revokeUserSessions(b.user._id);
    expect((await authenticate(b.token)).status).toBe(401);
    expect((await authenticate(second.token)).status).toBe(401);
  });

  test("deleting sessions directly (log out one or all other browsers) logs those out at once", async () => {
    const { user, token, sessionId } = await login();
    const other = await createSession(user._id, { label: "Ander", via: "passkey" });
    await authenticate(token);
    await authenticate(other.token);
    // Like DELETE /account/sessions: all but the current one
    await sessions().deleteMany({ user: user._id, _id: { $ne: sessionId } });
    expect((await authenticate(other.token)).status).toBe(401);
    expect((await authenticate(token)).status).toBe(200);
    // Like DELETE /account/sessions/:id
    await sessions().deleteOne({ _id: sessionId, user: user._id });
    expect((await authenticate(token)).status).toBe(401);
  });

  test("role, name and passkey changes show on the next request", async () => {
    const { user, token } = await login();
    await authenticate(token);
    await updateAccounts({ _id: user._id }, { $set: { admin: true } });
    expect((await authenticate(token)).user?.admin).toBe(true);
    await User.findOneAndUpdate({ _id: user._id }, { $set: { name: "Nieuw" } });
    expect((await authenticate(token)).user?.name).toBe("Nieuw");
    await updateAccounts(
      { _id: user._id },
      { $push: { passkeys: { credentialId: "c1", publicKey: Buffer.from("pk"), counter: 0, transports: [], name: "Key", createdAt: new Date() } } },
    );
    expect((await authenticate(token)).user?.passkeys).toHaveLength(1);
  });

  test("a deleted user is logged out at once", async () => {
    const { user, token } = await login();
    await authenticate(token);
    await deleteAccounts({ _id: user._id });
    expect((await authenticate(token)).status).toBe(401);
  });

  test("a write with a broad filter (updateMany, bulkWrite) clears the cache", async () => {
    const { token } = await login();
    await authenticate(token);
    await User.updateMany({}, { $set: { name: "Iedereen" } });
    expect((await authenticate(token)).user?.name).toBe("Iedereen");
    await authenticate(token);
    await User.bulkWrite([{ updateMany: { filter: {}, update: { $set: { name: "Bulk" } } } }]);
    expect((await authenticate(token)).user?.name).toBe("Bulk");
  });

  test("a lookup that raced a write is not cached", () => {
    const epoch = sessionCacheEpoch();
    clearSessionCache(); // a write happened meanwhile
    cacheSession("s1", { _id: "u1", name: "Oud" }, new Date(Date.now() + 60_000), epoch);
    expect(getCachedSession("s1")).toBeNull();
    cacheSession("s1", { _id: "u1", name: "Nieuw" }, new Date(Date.now() + 60_000), sessionCacheEpoch());
    expect(getCachedSession("s1")?.user.name).toBe("Nieuw");
  });

  test("an entry lives at most the TTL and never past the session's expiry", () => {
    const now = 1_000_000;
    cacheSession("s1", { _id: "u1" }, new Date(now + 60 * 60_000), sessionCacheEpoch(), now);
    expect(getCachedSession("s1", now + SESSION_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(getCachedSession("s1", now + SESSION_CACHE_TTL_MS)).toBeNull();
    cacheSession("s2", { _id: "u1" }, new Date(now + 1000), sessionCacheEpoch(), now);
    expect(getCachedSession("s2", now + 1000)).toBeNull();
  });
});
