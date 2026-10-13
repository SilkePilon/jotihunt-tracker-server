import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installFakeWebauthn } from "../test/webauthn";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { tokenFor, withSession } from "../test/auth";
import { User } from "../models/user.model";
import { sessions } from "./models";
import { createAccount } from "./user-store";

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
  headers.set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const passkey = (id: string) => ({ credentialId: id, publicKey: Buffer.from(`pk-${id}`), counter: 0, transports: ["internal"], name: "Test" });

async function loginWith(credentialId: string, signature = "valid") {
  const { challengeId } = await json<{ challengeId: string }>(await request("/auth/passkey/login/options", { method: "POST" }));
  return request("/auth/passkey/login/verify", { method: "POST", json: { challengeId, response: { id: credentialId, response: { signature } } } });
}

describe("passkey login", () => {
  test("a known passkey logs in: session token, public user, counter bumped", async () => {
    const user = await createAccount({ name: "Jesse", passkey: passkey("cred-1") });
    const res = await loginWith("cred-1");
    expect(res.status).toBe(200);
    const body = await json<{ token: string; user: Record<string, unknown> }>(res);
    expect(body.user).toEqual({ _id: String(user._id), name: "Jesse", admin: false, tutorialVersion: 0, passkeyCount: 1 });
    expect((await request("/auth/me", { token: body.token })).status).toBe(200);
    const stored = await User.findById(user._id);
    expect(stored!.passkeys[0].counter).toBe(1);
    expect(stored!.passkeys[0].lastUsedAt).toBeInstanceOf(Date);
    expect((await sessions().findOne({ user: user._id }).lean())!.label).toBe("Firefox op Linux");
  });

  test("an unknown passkey is a 401 UNKNOWN_PASSKEY, a bad signature 401 PASSKEY_FAILED", async () => {
    await createAccount({ name: "Jesse", passkey: passkey("cred-1") });
    const unknown = await loginWith("cred-x");
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).code).toBe("UNKNOWN_PASSKEY");
    const bad = await loginWith("cred-1", "forged");
    expect(bad.status).toBe(401);
    expect((await json(bad)).code).toBe("PASSKEY_FAILED");
  });

  test("a challenge works once: replaying it is a 400 CHALLENGE_EXPIRED", async () => {
    await createAccount({ name: "Jesse", passkey: passkey("cred-1") });
    const { challengeId } = await json<{ challengeId: string }>(await request("/auth/passkey/login/options", { method: "POST" }));
    const body = { challengeId, response: { id: "cred-1", response: { signature: "valid" } } };
    expect((await request("/auth/passkey/login/verify", { method: "POST", json: body })).status).toBe(200);
    const replay = await request("/auth/passkey/login/verify", { method: "POST", json: body });
    expect(replay.status).toBe(400);
    expect((await json(replay)).code).toBe("CHALLENGE_EXPIRED");
  });
});

describe("me and logout", () => {
  test("logout revokes only the current session", async () => {
    const user = await withSession(await User.create({ name: "Jesse" }));
    const first = tokenFor(user);
    await withSession(user);
    const second = tokenFor(user);
    expect((await request("/auth/logout", { method: "POST", token: second })).status).toBe(204);
    expect((await request("/auth/me", { token: second })).status).toBe(401);
    expect((await request("/auth/me", { token: first })).status).toBe(200);
  });
});
