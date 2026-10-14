import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installFakeWebauthn } from "../test/webauthn";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { tokenFor, withSession } from "../test/auth";
import { User } from "../models/user.model";
import { sessions } from "./models";
import { createAccount } from "./user-store";
import { signDeviceToken } from "../services/access-token";

installFakeWebauthn();
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
process.env.PUBLIC_APP_URL = "https://jotihunt.test";
const { app } = await import("../app");

let server: Server;
let base: string;
beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(clearTestDb);
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const passkey = (id: string) => ({ credentialId: id, publicKey: Buffer.from(`pk-${id}`), counter: 0, transports: ["internal"], name: `Key ${id}` });
type Overview = {
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  sessions: { id: string; label: string; via: string; current: boolean }[];
  devices: { id: string; name: string }[];
};

async function userWithTwoKeys() {
  const user = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
  await User.updateOne({ _id: user._id }, { $push: { passkeys: { ...passkey("cred-2"), createdAt: new Date(), lastUsedAt: null } } });
  return user;
}

describe("account overview", () => {
  test("passkeys without key material, own live sessions with current first-class flag, Android devices", async () => {
    const jesse = await userWithTwoKeys();
    await User.updateOne({ _id: jesse._id }, { $push: { devices: { id: "phone-1", name: "Pixel", createdAt: new Date() } } });
    const other = await withSession(await createAccount({ name: "Noor", passkey: passkey("cred-9") }));
    const res = await request("/account", { token: tokenFor(jesse) });
    expect(res.status).toBe(200);
    const body = await json<Overview>(res);
    expect(body.passkeys.map((p) => p.id)).toEqual(["cred-1", "cred-2"]);
    expect(body.passkeys[0].name).toBe("Key cred-1");
    expect(JSON.stringify(body)).not.toContain("pk-cred");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ label: "Test", via: "passkey", current: true });
    expect(body.devices.map((d) => d.id)).toEqual(["phone-1"]);
    expect(JSON.stringify(body)).not.toContain(String(other._id));
  });

  test("expired sessions are not listed; device tokens get 403", async () => {
    const jesse = await userWithTwoKeys();
    await sessions().create({ user: jesse._id, label: "Oud", via: "passkey", createdAt: new Date(0), lastUsedAt: new Date(0), expiresAt: new Date(Date.now() - 1000) });
    expect((await json<Overview>(await request("/account", { token: tokenFor(jesse) }))).sessions).toHaveLength(1);
    await User.updateOne({ _id: jesse._id }, { $push: { devices: { id: "phone-1", name: "Pixel", createdAt: new Date() } } });
    expect((await request("/account", { token: signDeviceToken(jesse, "phone-1") })).status).toBe(403);
  });
});

describe("passkeys", () => {
  test("rename: trimmed, 1-40 chars, unknown id 404", async () => {
    const jesse = await userWithTwoKeys();
    const token = tokenFor(jesse);
    expect((await request("/account/passkeys/cred-1", { method: "PATCH", token, json: { name: "  Telefoon  " } })).status).toBe(204);
    expect((await User.findById(jesse._id))!.passkeys[0].name).toBe("Telefoon");
    expect((await request("/account/passkeys/cred-1", { method: "PATCH", token, json: { name: "   " } })).status).toBe(400);
    expect((await request("/account/passkeys/cred-1", { method: "PATCH", token, json: { name: "x".repeat(41) } })).status).toBe(400);
    expect((await request("/account/passkeys/nope", { method: "PATCH", token, json: { name: "A" } })).status).toBe(404);
  });

  test("remove: answers the updated user; the last one is refused with LAST_PASSKEY", async () => {
    const jesse = await userWithTwoKeys();
    const token = tokenFor(jesse);
    const removed = await request("/account/passkeys/cred-1", { method: "DELETE", token });
    expect(removed.status).toBe(200);
    expect((await json<{ user: { passkeyCount: number } }>(removed)).user.passkeyCount).toBe(1);
    const last = await request("/account/passkeys/cred-2", { method: "DELETE", token });
    expect(last.status).toBe(409);
    expect((await json(last)).code).toBe("LAST_PASSKEY");
    expect((await User.findById(jesse._id))!.passkeys).toHaveLength(1);
    expect((await request("/account/passkeys/nope", { method: "DELETE", token })).status).toBe(404);
  });

  test("two removals at the same time never remove the last passkey", async () => {
    const jesse = await userWithTwoKeys();
    const token = tokenFor(jesse);
    const responses = await Promise.all([
      request("/account/passkeys/cred-1", { method: "DELETE", token }),
      request("/account/passkeys/cred-2", { method: "DELETE", token }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await User.findById(jesse._id))!.passkeys).toHaveLength(1);
  });

  test("another user's passkey is 404", async () => {
    await userWithTwoKeys();
    const noor = await withSession(await createAccount({ name: "Noor", passkey: passkey("cred-9") }));
    expect((await request("/account/passkeys/cred-1", { method: "DELETE", token: tokenFor(noor) })).status).toBe(404);
  });
});

describe("sessions", () => {
  test("revoke one (own only), then all others; the current one keeps working", async () => {
    const jesse = await userWithTwoKeys();
    const current = tokenFor(jesse);
    await withSession(jesse);
    const second = tokenFor(jesse);
    await withSession(jesse);
    const third = tokenFor(jesse);
    const noor = await withSession(await createAccount({ name: "Noor", passkey: passkey("cred-9") }));

    const list = (await json<Overview>(await request("/account", { token: current }))).sessions;
    expect(list).toHaveLength(3);
    const secondId = list.find((s) => !s.current)!.id;

    expect((await request(`/account/sessions/${secondId}`, { method: "DELETE", token: tokenFor(noor) })).status).toBe(404);
    expect((await request("/account/sessions/not-an-id", { method: "DELETE", token: current })).status).toBe(404);
    expect((await request(`/account/sessions/${secondId}`, { method: "DELETE", token: current })).status).toBe(204);

    const others = await request("/account/sessions", { method: "DELETE", token: current });
    expect(others.status).toBe(200);
    expect((await json(others)).removed).toBe(1);
    expect((await request("/auth/me", { token: current })).status).toBe(200);
    expect((await request("/auth/me", { token: second })).status).toBe(401);
    expect((await request("/auth/me", { token: third })).status).toBe(401);
    expect((await request("/auth/me", { token: tokenFor(noor) })).status).toBe(200);
  });

  test("revoking the current session logs this browser out", async () => {
    const jesse = await userWithTwoKeys();
    const token = tokenFor(jesse);
    const [own] = (await json<Overview>(await request("/account", { token }))).sessions;
    expect((await request(`/account/sessions/${own.id}`, { method: "DELETE", token })).status).toBe(204);
    expect((await request("/auth/me", { token })).status).toBe(401);
  });
});
