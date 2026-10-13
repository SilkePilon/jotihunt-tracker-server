import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installFakeWebauthn } from "../test/webauthn";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { tokenFor, withSession } from "../test/auth";
import { User } from "../models/user.model";
import { sessions } from "./models";
import { createAccount } from "./user-store";
import { createInvite } from "./invites";
import { setInvitesPaused } from "./invite-setting";
import { createRecoveryLink } from "./recovery";
import { Team } from "../models/team.model";

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

describe("invites: public", () => {
  test("info shows the group, inviter and counts; unknown codes are 404", async () => {
    process.env.HOME_TEAM_API_ID = "66";
    await Team.collection.insertOne({ apiId: 66, name: "Scouting Elburg", logoUrl: "https://cdn.jotihunt.net/elburg.png" });
    const admin = await User.create({ name: "Silke", admin: true });
    const invite = await createInvite({ createdBy: admin._id, expiry: "1d", maxUses: null });
    const res = await request(`/invites/${invite.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ valid: true, reason: null, group: { name: "Scouting Elburg", logoUrl: "https://cdn.jotihunt.net/elburg.png" }, invitedBy: "Silke", memberCount: 1 });
    const unknown = await request("/invites/ZZZZZZZZ");
    expect(unknown.status).toBe(404);
    expect(await json<Record<string, unknown>>(unknown)).toEqual({ valid: false, reason: "unknown" });
    delete process.env.HOME_TEAM_API_ID;
  });

  test("signup with a passkey: account, session, invite use, passkey stored", async () => {
    const admin = await User.create({ name: "Silke", admin: true });
    const invite = await createInvite({ createdBy: admin._id, expiry: "1d", maxUses: 1 });
    const options = await json<{ challengeId: string; options: { user: { name: string } } }>(
      await request(`/invites/${invite.code}/register/options`, { method: "POST", json: { name: "  Jesse " } }),
    );
    expect(options.options.user.name).toBe("Jesse");
    const res = await request(`/invites/${invite.code}/register/verify`, { method: "POST", json: { challengeId: options.challengeId, response: { id: "cred-new" } } });
    expect(res.status).toBe(201);
    const body = await json<{ token: string; user: { name: string; passkeyCount: number; admin: boolean } }>(res);
    expect(body.user).toMatchObject({ name: "Jesse", passkeyCount: 1, admin: false });
    expect((await request("/auth/me", { token: body.token })).status).toBe(200);
    const created = await User.findOne({ name: "Jesse" });
    expect(String(created!.invite)).toBe(String(invite._id));
    expect(created!.passkeys[0].name).toBe("Firefox op Linux");
    // maxUses 1: the next signup is refused
    const again = await request(`/invites/${invite.code}/register/no-passkey`, { method: "POST", json: { name: "Tim" } });
    expect(again.status).toBe(410);
    expect((await json(again)).reason).toBe("full");
  });

  test("signup without passkey works and gives a session", async () => {
    const admin = await User.create({ name: "Silke", admin: true });
    const invite = await createInvite({ createdBy: admin._id, expiry: "1d", maxUses: null });
    const res = await request(`/invites/${invite.code}/register/no-passkey`, { method: "POST", json: { name: "Tim" } });
    expect(res.status).toBe(201);
    expect((await json<{ user: { passkeyCount: number } }>(res)).user.passkeyCount).toBe(0);
  });

  test("a failed passkey does not use the invite; a bad name is a 400", async () => {
    const admin = await User.create({ name: "Silke", admin: true });
    const invite = await createInvite({ createdBy: admin._id, expiry: "1d", maxUses: 1 });
    const { challengeId } = await json<{ challengeId: string }>(await request(`/invites/${invite.code}/register/options`, { method: "POST", json: { name: "Jesse" } }));
    const bad = await request(`/invites/${invite.code}/register/verify`, { method: "POST", json: { challengeId, response: { id: "bad" } } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("PASSKEY_FAILED");
    expect((await request(`/invites/${invite.code}/register/no-passkey`, { method: "POST", json: { name: "Jesse" } })).status).toBe(201);
    expect((await request(`/invites/${invite.code}/register/options`, { method: "POST", json: { name: "" } })).status).toBe(400);
  });

  test("paused invites are refused with reason paused", async () => {
    const admin = await User.create({ name: "Silke", admin: true });
    const invite = await createInvite({ createdBy: admin._id, expiry: "1d", maxUses: null });
    await setInvitesPaused(true, null);
    const info = await json(await request(`/invites/${invite.code}`));
    expect(info).toMatchObject({ valid: false, reason: "paused" });
    const res = await request(`/invites/${invite.code}/register/no-passkey`, { method: "POST", json: { name: "Tim" } });
    expect(res.status).toBe(410);
    expect((await json(res)).reason).toBe("paused");
  });
});

describe("invites: admin", () => {
  test("create, list, revoke; non-admins get 403", async () => {
    const admin = await withSession(await User.create({ name: "Silke", admin: true }));
    const hunter = await withSession(await User.create({ name: "Tim" }));
    expect((await request("/admin/invites", { token: tokenFor(hunter) })).status).toBe(403);
    const created = await request("/admin/invites", { method: "POST", token: tokenFor(admin), json: { expiry: "1d", maxUses: 25 } });
    expect(created.status).toBe(201);
    const invite = await json<{ _id: string; code: string; url: string; state: string; createdBy: { name: string } }>(created);
    expect(invite.url).toBe(`https://jotihunt.test/invite/${invite.code}`);
    expect(invite).toMatchObject({ state: "active", createdBy: { name: "Silke" } });
    expect((await json<unknown[]>(await request("/admin/invites", { token: tokenFor(admin) })))).toHaveLength(1);
    const revoked = await request(`/admin/invites/${invite._id}`, { method: "DELETE", token: tokenFor(admin) });
    expect((await json(revoked)).state).toBe("revoked");
    expect((await request(`/admin/invites/${invite._id}`, { method: "DELETE", token: tokenFor(admin) })).status).toBe(404);
  });

  test("invalid expiry or max uses is a 400", async () => {
    const admin = await withSession(await User.create({ name: "Silke", admin: true }));
    expect((await request("/admin/invites", { method: "POST", token: tokenFor(admin), json: { expiry: "2d", maxUses: null } })).status).toBe(400);
    expect((await request("/admin/invites", { method: "POST", token: tokenFor(admin), json: { expiry: "1d", maxUses: 3 } })).status).toBe(400);
  });

  test("invites-paused setting: read by anyone logged in, written by admins", async () => {
    const admin = await withSession(await User.create({ name: "Silke", admin: true }));
    const hunter = await withSession(await User.create({ name: "Tim" }));
    expect(await json<Record<string, unknown>>(await request("/settings/invites-paused", { token: tokenFor(hunter) }))).toEqual({ paused: false });
    expect((await request("/settings/invites-paused", { method: "PUT", token: tokenFor(hunter), json: { paused: true } })).status).toBe(403);
    expect(await json<Record<string, unknown>>(await request("/settings/invites-paused", { method: "PUT", token: tokenFor(admin), json: { paused: true } }))).toEqual({ paused: true });
  });
});

const tokenOf = (url: string) => url.split("/herstel/")[1];

describe("herstel-links", () => {
  test("admin makes a link; it adds a passkey, logs in, and works once", async () => {
    const admin = await withSession(await User.create({ name: "Silke", admin: true }));
    const mark = await User.create({ name: "Mark", admin: true });
    const made = await request(`/admin/users/${mark._id}/recovery-link`, { method: "POST", token: tokenFor(admin) });
    expect(made.status).toBe(201);
    const { url } = await json<{ url: string }>(made);
    expect(url).toStartWith("https://jotihunt.test/herstel/");
    const token = tokenOf(url);
    expect(await json<Record<string, unknown>>(await request(`/herstel/${token}`))).toEqual({ valid: true, name: "Mark" });
    const { challengeId } = await json<{ challengeId: string }>(await request(`/herstel/${token}/register/options`, { method: "POST" }));
    const res = await request(`/herstel/${token}/register/verify`, { method: "POST", json: { challengeId, response: { id: "cred-mark" } } });
    expect(res.status).toBe(200);
    expect((await json<{ user: { name: string; passkeyCount: number } }>(res)).user).toMatchObject({ name: "Mark", passkeyCount: 1 });
    expect((await request(`/herstel/${token}`)).status).toBe(404);
    expect((await request(`/herstel/${token}/no-passkey`, { method: "POST" })).status).toBe(410);
  });

  test("without passkey: logs in once; expired links are 404", async () => {
    const user = await User.create({ name: "Tim" });
    const { url } = await createRecoveryLink(user._id, null);
    expect((await request(`/herstel/${tokenOf(url)}/no-passkey`, { method: "POST" })).status).toBe(200);
    const old = await createRecoveryLink(user._id, null, new Date(Date.now() - 2 * 60 * 60 * 1000));
    expect((await request(`/herstel/${tokenOf(old.url)}`)).status).toBe(404);
  });

  test("non-admins can not make links", async () => {
    const hunter = await withSession(await User.create({ name: "Tim" }));
    expect((await request(`/admin/users/${hunter._id}/recovery-link`, { method: "POST", token: tokenFor(hunter) })).status).toBe(403);
  });
});

describe("account: add passkey", () => {
  test("a logged-in user adds a passkey", async () => {
    const user = await withSession(await User.create({ name: "Tim" }));
    const { challengeId, options } = await json<{ challengeId: string; options: { excludeCredentials: unknown[] } }>(
      await request("/account/passkeys/options", { method: "POST", token: tokenFor(user) }),
    );
    expect(options.excludeCredentials).toEqual([]);
    const res = await request("/account/passkeys/verify", { method: "POST", token: tokenFor(user), json: { challengeId, response: { id: "cred-tim" } } });
    expect(res.status).toBe(201);
    expect((await json<{ user: { passkeyCount: number } }>(res)).user.passkeyCount).toBe(1);
  });

  test("a challenge of another user is refused", async () => {
    const a = await withSession(await User.create({ name: "A" }));
    const b = await withSession(await User.create({ name: "B" }));
    const { challengeId } = await json<{ challengeId: string }>(await request("/account/passkeys/options", { method: "POST", token: tokenFor(a) }));
    const res = await request("/account/passkeys/verify", { method: "POST", token: tokenFor(b), json: { challengeId, response: { id: "cred-b" } } });
    expect(res.status).toBe(400);
  });
});
