import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { jotiboardLinkModel } from "../models/jotiboard-link.model";
import { User } from "../models/user.model";
import { JotiboardService, setJotiboardService } from "../services/jotiboard.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { FakeImporter, FakeJotiboardClient, PASSWORD } from "../test/jotiboard-client";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
let server: Server;
let base: string;
let realDb: Connection;
let client: FakeJotiboardClient;
let service: JotiboardService;

beforeAll(async () => {
  await connectTestDb();
  realDb = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await jotiboardLinkModel(realDb).deleteMany({});
  client = new FakeJotiboardClient(() => new Date());
  service = new JotiboardService({ config: { sessionKey: randomBytes(32).toString("base64") }, connection: realDb, client, importer: new FakeImporter(), logger: silent, autoPoll: false });
  await service.start();
  setJotiboardService(service);
});
afterEach(async () => {
  setJotiboardService(null);
  await service.stop();
});
afterAll(async () => {
  server.close();
  await realDb.close();
  await disconnectTestDb();
});

const createUser = async (admin = false) => withSession(await User.create({ name: admin ? "Admin" : "Hunter", admin }));
function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/admin/jotiboard"],
  ["POST", "/admin/jotiboard/link", { username: "user", password: PASSWORD }],
  ["DELETE", "/admin/jotiboard/link"],
  ["PATCH", "/admin/jotiboard", { syncEnabled: false }],
  ["DELETE", "/admin/jotiboard/imports"],
];

describe("/admin/jotiboard", () => {
  test("admins only", async () => {
    const hunter = tokenFor(await createUser());
    for (const [method, path, json] of ROUTES) {
      expect((await request(path, { method, json })).status).toBe(401);
      expect((await request(path, { method, json, token: hunter })).status).toBe(403);
    }
    expect(client.calls).toEqual([]);
  });

  test("link, toggle, purge, unlink", async () => {
    const admin = tokenFor(await createUser(true));
    expect(await (await request("/admin/jotiboard", { token: admin })).json()).toEqual({ state: "unlinked", counts: { pins: 0, hints: 0 } });

    const linked = await request("/admin/jotiboard/link", { method: "POST", token: admin, json: { username: "user", password: PASSWORD } });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ state: "linked", username: "user", syncEnabled: true });
    expect(client.calls).toEqual(["signIn user"]);

    const off = await request("/admin/jotiboard", { method: "PATCH", token: admin, json: { syncEnabled: false } });
    expect(await off.json()).toMatchObject({ syncEnabled: false });

    const purged = await request("/admin/jotiboard/imports", { method: "DELETE", token: admin });
    expect(await purged.json()).toMatchObject({ removed: { markers: 0, hints: 0 }, status: { state: "linked" } });

    expect(await (await request("/admin/jotiboard/link", { method: "DELETE", token: admin })).json()).toMatchObject({ state: "unlinked" });
  });

  test("validation and wrong password", async () => {
    const admin = tokenFor(await createUser(true));
    const empty = await request("/admin/jotiboard/link", { method: "POST", token: admin, json: { username: " ", password: "" } });
    expect(empty.status).toBe(400);
    const wrong = await request("/admin/jotiboard/link", { method: "POST", token: admin, json: { username: "user", password: "nope" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ message: "Ongeldige gebruikersnaam of wachtwoord" });
    const badToggle = await request("/admin/jotiboard", { method: "PATCH", token: admin, json: { syncEnabled: "yes" } });
    expect(badToggle.status).toBe(400);
  });

  test("without a service: unavailable", async () => {
    setJotiboardService(null);
    const admin = tokenFor(await createUser(true));
    expect(await (await request("/admin/jotiboard", { token: admin })).json()).toEqual({ state: "unavailable" });
  });
});
