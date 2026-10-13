import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { life360LinkModel } from "../models/life360-link.model";
import { User } from "../models/user.model";
import { Life360CodeInvalidError } from "../services/life360.client";
import { Life360Service, setLife360Service } from "../services/life360.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { FakeLife360Client } from "../test/life360-client";
import { FIX_ISO, rawMember } from "../test/life360-fixtures";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
let server: Server;
let base: string;
let realDb: Connection;
let client: FakeLife360Client;
let service: Life360Service;

beforeAll(async () => {
  await connectTestDb();
  realDb = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await life360LinkModel(realDb).deleteMany({});
  client = new FakeLife360Client();
  service = new Life360Service({ config: { sessionKey: randomBytes(32).toString("base64") }, connection: realDb, client, logger: silent, autoPoll: false });
  await service.start();
  setLife360Service(service);
});
afterEach(async () => {
  setLife360Service(null);
  await service.stop();
});
afterAll(async () => {
  server.close();
  await realDb.close();
  await disconnectTestDb();
});

const createUser = async (admin = false) => withSession(await User.create({ name: admin ? "Admin" : "Hunter", admin }));
const tokenOf = (user: { _id: unknown }) => tokenFor(user);

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

const ADMIN_ROUTES: [string, string, unknown?][] = [
  ["GET", "/admin/life360"],
  ["POST", "/admin/life360/code", { email: "a@b.nl" }],
  ["POST", "/admin/life360/verify", { code: "123456" }],
  ["POST", "/admin/life360/circle", { circleId: "c1" }],
  ["POST", "/admin/life360/token", { token: "tok" }],
  ["POST", "/admin/life360/refresh"],
  ["DELETE", "/admin/life360/link"],
];

describe("/admin/life360", () => {
  test("admins only", async () => {
    const user = tokenOf(await createUser());
    for (const [method, path, json] of ADMIN_ROUTES) {
      expect((await request(path, { method, json })).status).toBe(401);
      expect((await request(path, { method, json, token: user })).status).toBe(403);
    }
    expect(client.calls).toEqual([]);
  });

  test("link by e-mail code and circle choice, refresh, unlink", async () => {
    client.circleList = [
      { id: "c1", name: "Jotihunt" },
      { id: "c2", name: "Familie" },
    ];
    const admin = tokenOf(await createUser(true));
    expect(await (await request("/admin/life360", { token: admin })).json()).toEqual({ state: "unlinked" });

    expect((await request("/admin/life360/code", { method: "POST", token: admin, json: { email: "geen adres" } })).status).toBe(400);
    const code = await request("/admin/life360/code", { method: "POST", token: admin, json: { email: " Jotihunt@Example.nl " } });
    expect(code.status).toBe(200);
    expect(await code.json()).toMatchObject({ state: "code", email: "jotihunt@example.nl" });
    const again = await request("/admin/life360/code", { method: "POST", token: admin, json: { email: "jotihunt@example.nl" } });
    expect(again.status).toBe(429);
    expect((await again.json()).message).toBe("Even wachten, je kunt zo weer een code sturen.");

    expect((await request("/admin/life360/verify", { method: "POST", token: admin, json: { code: "12a456" } })).status).toBe(400);
    client.verifyError = new Life360CodeInvalidError("mismatch");
    const wrong = await request("/admin/life360/verify", { method: "POST", token: admin, json: { code: "000000" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ message: "Code klopt niet of is verlopen." });
    client.verifyError = null;
    const verified = await request("/admin/life360/verify", { method: "POST", token: admin, json: { code: "123456" } });
    expect(await verified.json()).toEqual({ state: "circle", email: "jotihunt@example.nl", circles: client.circleList });

    expect((await request("/admin/life360/circle", { method: "POST", token: admin, json: { circleId: "c9" } })).status).toBe(400);
    const chosen = await request("/admin/life360/circle", { method: "POST", token: admin, json: { circleId: "c2" } });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toMatchObject({ state: "linked", circleName: "Familie", memberCount: 0 });

    client.memberAnswers = [{ notModified: false, etag: "e1", members: [rawMember("m1", "Silke", "Pilon")] }];
    await service.pollOnce();
    expect(await (await request("/admin/life360", { token: admin })).json()).toMatchObject({ state: "linked", memberCount: 1 });
    const refresh = await request("/admin/life360/refresh", { method: "POST", token: admin });
    expect(refresh.status).toBe(202);
    expect(await refresh.json()).toEqual({ refreshAvailableAt: expect.any(String) });
    expect((await request("/admin/life360/refresh", { method: "POST", token: admin })).status).toBe(429);

    const unlink = await request("/admin/life360/link", { method: "DELETE", token: admin });
    expect(unlink.status).toBe(200);
    expect(await unlink.json()).toEqual({ state: "unlinked" });
  });

  test("without a service or without LIFE360_SESSION_KEY: unavailable", async () => {
    const admin = tokenOf(await createUser(true));
    setLife360Service(null);
    expect(await (await request("/admin/life360", { token: admin })).json()).toEqual({ state: "unavailable" });
    expect((await request("/admin/life360/code", { method: "POST", token: admin, json: { email: "a@b.nl" } })).status).toBe(503);
    expect(await (await request("/life360/members", { token: admin })).json()).toEqual({ linked: false, stale: false, members: [] });
    expect((await request("/life360/avatar/m1", { token: admin })).status).toBe(404);

    const off = new Life360Service({ config: null, connection: realDb, client, logger: silent, autoPoll: false });
    setLife360Service(off);
    expect(await (await request("/admin/life360", { token: admin })).json()).toEqual({ state: "unavailable" });
    expect((await request("/admin/life360/token", { method: "POST", token: admin, json: { token: "tok" } })).status).toBe(503);
  });
});

describe("/life360", () => {
  test("members and avatars for every logged-in user, without addresses, contact details or Life360 URLs", async () => {
    const user = tokenOf(await createUser());
    const admin = tokenOf(await createUser(true));
    expect((await request("/life360/members")).status).toBe(401);
    expect(await (await request("/life360/members", { token: user })).json()).toEqual({ linked: false, stale: false, members: [] });

    expect((await request("/admin/life360/token", { method: "POST", token: admin, json: { token: "tok" } })).status).toBe(200);
    client.memberAnswers = [{ notModified: false, etag: "e1", members: [rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", "", { shareLocation: "0" })] }];
    await service.pollOnce();

    const response = await request("/life360/members", { token: user });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      linked: true,
      stale: false,
      members: [
        {
          id: "m1",
          name: "Silke P.",
          initials: "SP",
          avatarUrl: "/life360/avatar/m1",
          location: { lat: 52.0907, lon: 5.1214, accuracyM: 15, at: FIX_ISO, driving: false, speedKmh: 0, battery: 84, charging: false },
        },
        { id: "m2", name: "Anna", initials: "A", avatarUrl: "/life360/avatar/m2", location: null },
      ],
    });
    for (const secret of ["Dorpsstraat", "Scherpenzeel", "Thuis", "@example.nl", "+31612345678", "life360.com"]) expect(text).not.toContain(secret);

    client.avatars.set("https://www.life360.com/img/user_images/m1.jpg", { contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) });
    expect((await request("/life360/avatar/m1")).status).toBe(401);
    const avatar = await request("/life360/avatar/m1", { token: user });
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toBe("image/jpeg");
    expect(avatar.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(avatar.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await avatar.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
    // m2 has a Life360 avatar URL but Life360 has no image for it (fake: NotFound)
    expect((await request("/life360/avatar/m2", { token: user })).status).toBe(404);
    expect((await request("/life360/avatar/nobody", { token: user })).status).toBe(404);
  });

  test("an avatar memberId over 100 characters: 400", async () => {
    const user = tokenOf(await createUser());
    expect((await request(`/life360/avatar/${"a".repeat(100)}`, { token: user })).status).toBe(404);
    expect((await request(`/life360/avatar/${"a".repeat(101)}`, { token: user })).status).toBe(400);
    expect(client.avatarCalls).toBe(0);
  });
});
