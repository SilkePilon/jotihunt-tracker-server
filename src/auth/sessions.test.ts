import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { sessions } from "./models";
import { createSession, revokeSession, revokeUserSessions, SESSION_TOUCH_INTERVAL_MS, SESSION_TTL_MS, useSession } from "./sessions";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const userId = new mongoose.Types.ObjectId();
const t0 = new Date("2026-10-14T10:00:00Z");
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("sessions", () => {
  test("the token is a JWT with sid and kind web, valid a year", async () => {
    const { token, sessionId } = await createSession(userId, { label: "Firefox op Linux", via: "passkey" }, t0);
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { sid: string; kind: string; exp: number; iat: number };
    expect(decoded.sid).toBe(sessionId);
    expect(decoded.kind).toBe("web");
    expect(decoded.exp - decoded.iat).toBe(365 * 24 * 60 * 60);
    const stored = await sessions().findById(sessionId).lean();
    expect(stored).toMatchObject({ label: "Firefox op Linux", via: "passkey" });
    expect(stored!.expiresAt.getTime()).toBe(t0.getTime() + SESSION_TTL_MS);
  });

  test("useSession returns the session and does not write within the touch interval", async () => {
    const { sessionId } = await createSession(userId, { label: "x", via: "passkey" }, t0);
    const session = await useSession(sessionId, new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS - 1));
    await flush();
    expect(String(session!._id)).toBe(sessionId);
    expect((await sessions().findById(sessionId).lean())!.lastUsedAt.getTime()).toBe(t0.getTime());
  });

  test("after the touch interval the expiry slides to 30 days from now", async () => {
    const { sessionId } = await createSession(userId, { label: "x", via: "passkey" }, t0);
    const later = new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000);
    await useSession(sessionId, later);
    await flush();
    const stored = (await sessions().findById(sessionId).lean())!;
    expect(stored.lastUsedAt.getTime()).toBe(later.getTime());
    expect(stored.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
  });

  test("expired, revoked, unknown and malformed ids are null", async () => {
    const { sessionId } = await createSession(userId, { label: "x", via: "passkey" }, t0);
    expect(await useSession(sessionId, new Date(t0.getTime() + SESSION_TTL_MS))).toBeNull();
    expect(await useSession("nope")).toBeNull();
    expect(await useSession(String(new mongoose.Types.ObjectId()))).toBeNull();
    await revokeSession(sessionId);
    expect(await useSession(sessionId, t0)).toBeNull();
  });

  test("revokeUserSessions removes every session of that user only", async () => {
    await createSession(userId, { label: "a", via: "passkey" });
    await createSession(userId, { label: "b", via: "passkey" });
    const other = await createSession(new mongoose.Types.ObjectId(), { label: "c", via: "passkey" });
    await revokeUserSessions(userId);
    expect(await sessions().countDocuments()).toBe(1);
    expect(await useSession(other.sessionId)).not.toBeNull();
  });
});
