import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
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
async function createUser(fields: { admin?: boolean; password?: string; email?: string } = {}) {
  return User.create({
    email: fields.email ?? `user${++emailCounter}@test.nl`,
    name: "Test",
    password: await hashPassword(fields.password ?? "geheim"),
    admin: fields.admin ?? false,
    requiresPasswordChange: false,
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
  test("update-password signs out other sessions but keeps the current one", async () => {
    const user = await createUser({ password: "oud" });
    const other = tokenFor(user, nowSeconds() - 120);
    const current = tokenFor(user, nowSeconds() - 60);
    const res = await request("/auth/update-password", {
      method: "POST",
      token: current,
      json: { oldPassword: "oud", newPassword: "nieuw", confirmPassword: "nieuw" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(typeof body.accessToken).toBe("string");
    expect((await request("/markers", { token: current })).status).toBe(200);
    expect((await request("/markers", { token: body.accessToken })).status).toBe(200);
    expect((await request("/markers", { token: other })).status).toBe(401);

    const stored = await User.findById(user._id);
    expect(stored!.password).toStartWith("$argon2id$v=19$m=19456,t=2,");
    expect(await Bun.password.verify("nieuw", stored!.password)).toBe(true);
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
