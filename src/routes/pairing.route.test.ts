import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
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

const createUser = async () => withSession(await User.create({ name: "Hunter" }));
const webToken = (user: { _id: unknown }) => tokenFor(user);

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function pair(user: { _id: unknown }, deviceName = "Pixel 8") {
  const created = await request("/tracker/pair", { method: "POST", token: webToken(user) });
  expect(created.status).toBe(201);
  const { code } = (await created.json()) as { code: string };
  const response = await request("/auth/pair", { method: "POST", json: { code, deviceName } });
  return { response, code };
}

describe("app pairing", () => {
  test("a code from the site pairs the phone: device token, user and tracker status", async () => {
    const user = await createUser();
    const { response } = await pair(user);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string; expiresIn: number; device: { id: string; name: string }; user: { name: string }; tracker: { configured: boolean } };
    expect(body.device.name).toBe("Pixel 8");
    expect(body.user.name).toBe("Hunter");
    expect(body.expiresIn).toBe(30 * 24 * 60 * 60);
    expect(typeof body.tracker.configured).toBe("boolean");
    // The device token works on normal routes
    const me = await request("/tracker/me", { token: body.accessToken });
    expect(me.status).toBe(200);
  });

  test("a code works once", async () => {
    const user = await createUser();
    const { code } = await pair(user);
    const again = await request("/auth/pair", { method: "POST", json: { code } });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { message: string }).message).toContain("ongeldig of verlopen");
  });

  test("validation: missing code is 400", async () => {
    const response = await request("/auth/pair", { method: "POST", json: {} });
    expect(response.status).toBe(400);
  });

  test("creating a code needs a session", async () => {
    const response = await request("/tracker/pair", { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("device tokens", () => {
  test("removing the device revokes its token", async () => {
    const user = await createUser();
    const { response } = await pair(user);
    const { accessToken, device } = (await response.json()) as { accessToken: string; device: { id: string } };
    const removed = await request(`/auth/devices/${device.id}`, { method: "DELETE", token: webToken(user) });
    expect(removed.status).toBe(204);
    expect((await request("/tracker/me", { token: accessToken })).status).toBe(401);
  });

  test("DELETE /auth/devices/me unpairs the calling phone", async () => {
    const user = await createUser();
    const { response } = await pair(user);
    const { accessToken } = (await response.json()) as { accessToken: string };
    expect((await request("/auth/devices/me", { method: "DELETE", token: accessToken })).status).toBe(204);
    expect((await request("/tracker/me", { token: accessToken })).status).toBe(401);
  });

  test("refresh gives a new device token; a web token can't refresh", async () => {
    const user = await createUser();
    const { response } = await pair(user);
    const { accessToken } = (await response.json()) as { accessToken: string };
    const refreshed = await request("/auth/refresh", { method: "POST", token: accessToken });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { accessToken: string; expiresIn: number };
    expect((jwt.decode(body.accessToken) as { did: string }).did).toBe((jwt.decode(accessToken) as { did: string }).did);
    expect((await request("/auth/refresh", { method: "POST", token: webToken(user) })).status).toBe(400);
  });

  test("list marks the current device", async () => {
    const user = await createUser();
    const { response } = await pair(user, "Telefoon A");
    const { accessToken } = (await response.json()) as { accessToken: string };
    await pair(user, "Telefoon B");
    const list = await request("/auth/devices", { token: accessToken });
    const { devices } = (await list.json()) as { devices: { name: string; current: boolean }[] };
    expect(devices.map((d) => [d.name, d.current])).toEqual([["Telefoon A", true], ["Telefoon B", false]]);
  });

  test("unknown device id is 404", async () => {
    const user = await createUser();
    expect((await request("/auth/devices/nope", { method: "DELETE", token: webToken(user) })).status).toBe(404);
  });

  test("a device token without a registered device is a 401", async () => {
    const user = await createUser();
    const token = jwt.sign({ _id: String(user._id), did: "gone", kind: "device" }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    expect((await request("/tracker/me", { token })).status).toBe(401);
  });
});
