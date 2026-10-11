import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { Article } from "./models/article.model";
import { hashPassword, User } from "./models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "./test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app, isQuietRequest } = await import("./app");

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

const sign = (payload: object, options: jwt.SignOptions = { expiresIn: "36h" }) => jwt.sign(payload, process.env.JWT_SECRET!, options);
const tokenFor = (user: { _id: unknown }, iat?: number) => sign(iat === undefined ? { _id: user._id } : { _id: user._id, iat });
const nowSeconds = () => Math.floor(Date.now() / 1000);

let emailCounter = 0;
async function createUser(fields: { admin?: boolean; password?: string; email?: string; name?: string; requiresPasswordChange?: boolean } = {}) {
  return User.create({
    email: fields.email ?? `user${++emailCounter}@test.nl`,
    name: fields.name ?? "Test",
    password: await hashPassword(fields.password ?? "geheim"),
    admin: fields.admin ?? false,
    requiresPasswordChange: fields.requiresPasswordChange ?? false,
  });
}

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

describe("auth middleware", () => {
  test("a valid token passes", async () => {
    const user = await createUser();
    expect((await request("/markers", { token: tokenFor(user) })).status).toBe(200);
  });

  test("missing, invalid, expired or wrongly shaped tokens get 401", async () => {
    const user = await createUser();
    expect((await request("/markers")).status).toBe(401);
    expect((await request("/markers", { token: "nonsense" })).status).toBe(401);
    expect((await request("/markers", { token: sign({ _id: user._id }, { expiresIn: -10 }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ _id: "not-an-object-id" }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ _id: { $ne: null } }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ _id: "aaaaaaaaaaaaaaaaaaaaaaaa" }) })).status).toBe(401);
  });

  test("a database error is a 503, not a 401 (clients sign out on 401)", async () => {
    const user = await createUser();
    const error = Object.assign(new Error("connection refused"), { name: "MongoNetworkError" });
    const spy = spyOn(User, "findById").mockImplementation((() => Promise.reject(error)) as never);
    try {
      const res = await request("/markers", { token: tokenFor(user) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ message: "Database niet bereikbaar" });
    } finally {
      spy.mockRestore();
    }
  });

  test("other errors are a 500, not a 401", async () => {
    const user = await createUser();
    const spy = spyOn(User, "findById").mockImplementation((() => Promise.reject(new Error("bug"))) as never);
    try {
      expect((await request("/markers", { token: tokenFor(user) })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  test("tokens issued before the last password change get 401; users without the field keep working", async () => {
    const user = await createUser();
    const old = tokenFor(user, nowSeconds() - 60);
    expect((await request("/markers", { token: old })).status).toBe(200);
    await User.updateOne({ _id: user._id }, { passwordChangedAt: new Date((nowSeconds() - 30) * 1000) });
    expect((await request("/markers", { token: old })).status).toBe(401);
    expect((await request("/markers", { token: tokenFor(user) })).status).toBe(200);
  });
});

describe("passwords", () => {
  test("update-password signs out all sessions (older and newer) and returns a fresh token that works", async () => {
    const user = await createUser({ password: "oud" });
    const older = tokenFor(user, nowSeconds() - 120);
    const current = tokenFor(user, nowSeconds() - 60);
    const newer = tokenFor(user, nowSeconds() - 30);
    // Issued in the same second as the change, before it
    const sameSecond = tokenFor(user);
    const res = await request("/auth/update-password", {
      method: "POST",
      token: current,
      json: { oldPassword: "oud", newPassword: "nieuw", confirmPassword: "nieuw" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(typeof body.accessToken).toBe("string");
    expect((await request("/markers", { token: body.accessToken })).status).toBe(200);
    for (const token of [older, current, newer, sameSecond]) {
      expect((await request("/markers", { token })).status).toBe(401);
    }

    const stored = await User.findById(user._id);
    expect(stored!.password).toStartWith("$argon2id$v=19$m=19456,t=2,");
    expect(await Bun.password.verify("nieuw", stored!.password)).toBe(true);
    // A login right after the change (same second) gets a working token too
    const login = await request("/auth/login", { method: "POST", json: { email: user.email, password: "nieuw" } });
    const { accessToken } = (await login.json()) as { accessToken: string };
    expect((await request("/markers", { token: accessToken })).status).toBe(200);
  });

  test("login works with an old (default settings) hash and replaces it with the cheaper one", async () => {
    const user = await createUser();
    await User.updateOne({ _id: user._id }, { password: await Bun.password.hash("oud-wachtwoord") });
    const res = await request("/auth/login", { method: "POST", json: { email: user.email, password: "oud-wachtwoord" } });
    expect(res.status).toBe(200);
    const stored = await User.findById(user._id);
    expect(stored!.password).toStartWith("$argon2id$v=19$m=19456,t=2,");
    expect(await Bun.password.verify("oud-wachtwoord", stored!.password)).toBe(true);
    expect(stored!.passwordChangedAt).toBeUndefined();
    // The token from the login still works after the rehash
    const { accessToken } = (await res.json()) as { accessToken: string };
    expect((await request("/markers", { token: accessToken })).status).toBe(200);
  });

  test("an admin password reset signs the user out", async () => {
    const admin = await createUser({ admin: true });
    const user = await createUser();
    const userToken = tokenFor(user, nowSeconds() - 60);
    const res = await request(`/admin/users/${user._id}`, { method: "PUT", token: tokenFor(admin), json: { password: "reset" } });
    expect(res.status).toBe(200);
    expect((await request("/markers", { token: userToken })).status).toBe(401);
    const stored = await User.findById(user._id);
    expect(stored!.requiresPasswordChange).toBe(true);
    expect(stored!.password).toStartWith("$argon2id$v=19$m=19456,t=2,");
  });

  test("an admin resetting their own password keeps their session", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin, nowSeconds() - 60);
    expect((await request(`/admin/users/${admin._id}`, { method: "PUT", token, json: { password: "reset" } })).status).toBe(200);
    expect((await request("/markers", { token })).status).toBe(200);
  });
});

describe("required password change", () => {
  const REQUIRED = { message: "Wijzig eerst je wachtwoord.", code: "PASSWORD_CHANGE_REQUIRED" };

  test("every authenticated route answers 403 PASSWORD_CHANGE_REQUIRED", async () => {
    const user = await createUser({ admin: true, requiresPasswordChange: true });
    const token = tokenFor(user);
    const calls: [string, RequestInit & { json?: unknown }][] = [
      ["/markers", {}],
      ["/tracker/me", {}],
      ["/hints/board", {}],
      ["/hunt-reports", {}],
      ["/assignments", {}],
      ["/assignments/members", {}],
      ["/articles/read", {}],
      ["/notifications", {}],
      ["/admin/users", {}],
      ["/demo", {}],
      ["/settings/prediction", {}],
      ["/auth/tutorial", { method: "POST", json: { version: 1 } }],
      ["/tracker/pair", { method: "POST" }],
      ["/auth/refresh", { method: "POST" }],
      ["/auth/devices", {}],
      ["/push/subscribe", { method: "POST", json: { endpoint: "https://push.example.nl/x", keys: { p256dh: "a", auth: "b" } } }],
    ];
    for (const [path, init] of calls) {
      const res = await request(path, { ...init, token });
      expect([path, res.status]).toEqual([path, 403]);
      expect(await res.json()).toEqual(REQUIRED);
    }
  });

  test("an invalid or revoked token is still a 401 (sign out), not a 403", async () => {
    const user = await createUser({ requiresPasswordChange: true });
    expect((await request("/markers", { token: "nonsense" })).status).toBe(401);
    const old = tokenFor(user, nowSeconds() - 60);
    await User.updateOne({ _id: user._id }, { passwordChangedAt: new Date((nowSeconds() - 30) * 1000) });
    expect((await request("/markers", { token: old })).status).toBe(401);
  });

  test("the change screen can change the password and log out (push unsubscribe); then everything works", async () => {
    const user = await createUser({ password: "tijdelijk", requiresPasswordChange: true });
    const token = tokenFor(user, nowSeconds() - 60);
    const unsubscribe = await request("/push/subscribe", { method: "DELETE", token, json: { endpoint: "https://push.example.nl/x" } });
    expect(unsubscribe.status).toBe(204);

    const res = await request("/auth/update-password", {
      method: "POST",
      token,
      json: { oldPassword: "tijdelijk", newPassword: "eigen", confirmPassword: "eigen" },
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    expect((await User.findById(user._id))!.requiresPasswordChange).toBe(false);
    expect((await request("/markers", { token: accessToken })).status).toBe(200);
  });

  test("a wrong old password on the change screen is a 400 from update-password, flag stays", async () => {
    const user = await createUser({ password: "tijdelijk", requiresPasswordChange: true });
    const res = await request("/auth/update-password", {
      method: "POST",
      token: tokenFor(user),
      json: { oldPassword: "fout", newPassword: "eigen", confirmPassword: "eigen" },
    });
    expect(res.status).toBe(400);
    expect((await User.findById(user._id))!.requiresPasswordChange).toBe(true);
  });

  test("login still works and reports the flag", async () => {
    const user = await createUser({ password: "tijdelijk", requiresPasswordChange: true });
    const res = await request("/auth/login", { method: "POST", json: { email: user.email, password: "tijdelijk" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { requiresPasswordChange: boolean } }).user.requiresPasswordChange).toBe(true);
  });

  test("a user created by an admin must change their password", async () => {
    const admin = await createUser({ admin: true });
    const res = await request("/admin/users", { method: "POST", token: tokenFor(admin), json: { name: "Nieuw", email: "nieuw@test.nl", password: "tijdelijk" } });
    expect(res.status).toBe(201);
    expect((await User.findOne({ email: "nieuw@test.nl" }))!.requiresPasswordChange).toBe(true);
  });

  test("an admin resetting their own password chose it themselves: no forced change", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin, nowSeconds() - 60);
    expect((await request(`/admin/users/${admin._id}`, { method: "PUT", token, json: { password: "reset" } })).status).toBe(200);
    expect((await User.findById(admin._id))!.requiresPasswordChange).toBe(false);
    expect((await request("/markers", { token })).status).toBe(200);
  });
});

describe("admin user management", () => {
  test("the last admin can not delete or demote themselves", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin);
    const del = await request(`/admin/users/${admin._id}`, { method: "DELETE", token });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { message: string }).message).toBe("Er moet minstens één admin overblijven.");
    expect((await request(`/admin/users/${admin._id}`, { method: "PUT", token, json: { admin: false } })).status).toBe(409);
    expect((await User.findById(admin._id))!.admin).toBe(true);
  });

  test("with another admin left, demoting and deleting admins works", async () => {
    const a = await createUser({ admin: true });
    const b = await createUser({ admin: true });
    expect((await request(`/admin/users/${b._id}`, { method: "PUT", token: tokenFor(a), json: { admin: false } })).status).toBe(200);
    const c = await createUser({ admin: true });
    expect((await request(`/admin/users/${a._id}`, { method: "DELETE", token: tokenFor(a) })).status).toBe(200);
    expect(await User.countDocuments({ admin: true })).toBe(1);
    expect((await User.findById(c._id))!.admin).toBe(true);
  });

  test("two admins demoting/deleting each other at the same time leave one admin", async () => {
    for (let round = 0; round < 5; round++) {
      await clearTestDb();
      const a = await createUser({ admin: true });
      const b = await createUser({ admin: true });
      const results = await Promise.all([
        request(`/admin/users/${b._id}`, { method: "PUT", token: tokenFor(a), json: { admin: false } }),
        request(`/admin/users/${a._id}`, { method: round % 2 ? "DELETE" : "PUT", token: tokenFor(b), json: { admin: false } }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await User.countDocuments({ admin: true })).toBe(1);
    }
  });

  test("a duplicate e-mail that slips past the validator is a 400, not a 500", async () => {
    const admin = await createUser({ admin: true });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => request("/admin/users", { method: "POST", token: tokenFor(admin), json: { name: "N", email: "dubbel@test.nl", password: "x" } })),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1).every((status) => status === 400)).toBe(true);
    expect(await User.countDocuments({ email: "dubbel@test.nl" })).toBe(1);
  });
});

describe("hints page: assignments, read state and presence", () => {
  const makeArticle = (id: number, type: string) => Article.create({ id, title: `Artikel ${id}`, type, publishAt: new Date("2026-10-17T12:00:00Z"), content: "<div>tekst</div>" });

  test("without a token every route answers 401", async () => {
    const calls: [string, RequestInit & { json?: unknown }][] = [
      ["/assignments", {}],
      ["/assignments/members", {}],
      ["/articles/read", {}],
      ["/presence", { method: "POST", json: { itemId: 5 } }],
    ];
    for (const [path, init] of calls) expect([path, (await request(path, init)).status]).toEqual([path, 401]);
  });

  test("an assignment write without a body, and an owner write without owner, are a 400", async () => {
    const token = tokenFor(await createUser());
    await makeArticle(7, "assignment");
    for (const path of ["/assignments/7/status", "/assignments/7/owner", "/assignments/7/notes"]) {
      expect([path, (await request(path, { method: "POST", token })).status]).toEqual([path, 400]);
    }
    expect((await request("/assignments/7/owner", { method: "POST", token, json: {} })).status).toBe(400);
    expect((await request("/assignments/7/owner", { method: "POST", token, json: { overwrite: true } })).status).toBe(400);
    expect((await request("/assignments/7/owner", { method: "POST", token, json: { owner: "geen-id" } })).status).toBe(400);
    expect(await request("/assignments", { token }).then((res) => res.json())).toEqual([]);
  });

  test("the owner can be set to a user and to nobody (null)", async () => {
    const user = await createUser({ name: "Sanne" });
    const token = tokenFor(user);
    await makeArticle(7, "assignment");
    const given = await request("/assignments/7/owner", { method: "POST", token, json: { owner: String(user._id) } });
    expect(given.status).toBe(200);
    expect(((await given.json()) as { owner: { name: string } }).owner.name).toBe("Sanne");
    const taken = await request("/assignments/7/owner", { method: "POST", token, json: { owner: null } });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { owner?: unknown }).owner ?? null).toBeNull();
  });

  test("a status someone else set is a 409 with the conflict; overwrite: true goes through", async () => {
    const [a, b] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(7, "assignment");
    expect((await request("/assignments/7/status", { method: "POST", token: tokenFor(a), json: { status: "busy" } })).status).toBe(200);

    const refused = await request("/assignments/7/status", { method: "POST", token: tokenFor(b), json: { status: "skipped" } });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { message: string; conflict: { kind: string; value: string; by: { name: string } } };
    expect(body.conflict).toMatchObject({ kind: "status", value: "busy", by: { _id: String(a._id), name: "Sanne" } });
    expect(typeof body.message).toBe("string");

    const forced = await request("/assignments/7/status", { method: "POST", token: tokenFor(b), json: { status: "skipped", overwrite: true } });
    expect(forced.status).toBe(200);
    expect((await forced.json()) as { status: string; statusBy: { name: string } }).toMatchObject({ status: "skipped", statusBy: { name: "Daan" } });
  });

  test("presence: a heartbeat lists the caller, an array as itemId is a 400, leaving is a 204", async () => {
    const user = await createUser({ name: "Sanne" });
    const token = tokenFor(user);
    expect((await request("/presence", { method: "POST", token, json: { itemId: [1, 2] } })).status).toBe(400);
    expect((await request("/presence", { method: "POST", token, json: { itemId: [5] } })).status).toBe(400);
    expect((await request("/presence", { method: "POST", token })).status).toBe(400);
    expect((await request("/presence", { method: "POST", token, json: { itemId: 5, area: "zulu" } })).status).toBe(400);

    const beat = await request("/presence", { method: "POST", token, json: { itemId: 5, area: "CHARLIE" } });
    expect(beat.status).toBe(200);
    const list = (await beat.json()) as { userId: string; name: string; itemId: number; area?: string }[];
    expect(list.find((entry) => entry.userId === String(user._id))).toMatchObject({ name: "Sanne", itemId: 5, area: "charlie" });

    expect((await request("/presence", { method: "DELETE", token })).status).toBe(204);
    const after = (await (await request("/presence", { method: "POST", token: tokenFor(await createUser()), json: { itemId: "6" } })).json()) as { userId: string; itemId: number }[];
    expect(after.some((entry) => entry.userId === String(user._id))).toBe(false);
    expect(after.every((entry) => typeof entry.itemId === "number")).toBe(true);
  });

  test("marking an article read shows in the read state; a seeded test article is a 404", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await Promise.all([makeArticle(3, "news"), makeArticle(900001, "news")]);
    expect((await request("/articles/3/read", { method: "POST", token })).status).toBe(204);
    expect((await request("/articles/900001/read", { method: "POST", token })).status).toBe(404);
    const res = await request("/articles/read", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: [3], readBy: { "3": 1 } });
  });

  test("an admin's user answers never carry the read articles", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin);
    const created = await request("/admin/users", { method: "POST", token, json: { name: "Nieuw", email: "lezer@test.nl", password: "tijdelijk" } });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain("readArticles");
    const user = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { readArticles: [3] } });
    const updated = await request(`/admin/users/${user._id}`, { method: "PUT", token, json: { name: "Anders" } });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(await updated.json())).not.toContain("readArticles");
  });
});

describe("write rate limit", () => {
  test("POST /markers answers 429 after 30 writes per minute per user", async () => {
    const [a, b] = [await createUser(), await createUser()];
    // Invalid bodies (400) still count: the limit runs before validation
    for (let i = 0; i < 30; i++) expect((await request("/markers", { method: "POST", token: tokenFor(a), json: {} })).status).toBe(400);
    const limited = await request("/markers", { method: "POST", token: tokenFor(a), json: {} });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as { message: string }).message).toContain("Te veel");
    expect((await request("/markers", { method: "POST", token: tokenFor(b), json: {} })).status).toBe(400);
  });
});

describe("photo upload", () => {
  async function upload(bytes: Uint8Array<ArrayBuffer>, type: string) {
    const user = await createUser();
    const form = new FormData();
    form.append("photo", new Blob([bytes], { type }), "hunt.jpg");
    form.append("area", "invalid-area");
    return request("/hunt-reports", { method: "POST", token: tokenFor(user), body: form });
  }

  test("a file that is not really an image is rejected", async () => {
    const res = await upload(new TextEncoder().encode("<html><script>alert(1)</script></html>"), "image/jpeg");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("Foto is geen geldige JPEG-, PNG- of WebP-afbeelding.");
  });

  test("a real JPEG passes the upload check (and reaches validation)", async () => {
    const res = await upload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "image/jpeg");
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("errors");
  });
});

describe("http basics", () => {
  test("security headers, CORS preflight cache and no X-Powered-By", async () => {
    const res = await request("/nope");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
    const preflight = await request("/markers", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.nl", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-max-age")).toBe("86400");
  });

  test("large JSON is gzipped and ETag/304 still works", async () => {
    const admin = await createUser({ admin: true });
    await Promise.all(Array.from({ length: 30 }, () => createUser()));
    const token = tokenFor(admin);
    const first = await request("/admin/users", { token, headers: { "Accept-Encoding": "gzip" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-encoding")).toBe("gzip");
    expect(((await first.json()) as unknown[]).length).toBe(31);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await request("/admin/users", { token, headers: { "Accept-Encoding": "gzip", "If-None-Match": etag! } });
    expect(second.status).toBe(304);
  });

  test("successful reads and preflights are not logged; errors and writes are", () => {
    expect(isQuietRequest("GET", 200)).toBe(true);
    expect(isQuietRequest("GET", 304)).toBe(true);
    expect(isQuietRequest("OPTIONS", 204)).toBe(true);
    expect(isQuietRequest("GET", 401)).toBe(false);
    expect(isQuietRequest("GET", 500)).toBe(false);
    expect(isQuietRequest("POST", 201)).toBe(false);
  });
});
