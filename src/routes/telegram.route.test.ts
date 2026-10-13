import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose, { type Connection } from "mongoose";
import { AppNotification } from "../models/notification.model";
import { telegramLinkModel } from "../models/telegram-link.model";
import { telegramMessageModel } from "../models/telegram-message.model";
import { User } from "../models/user.model";
import { setTelegramService, TelegramService } from "../services/telegram.service";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { FakeGateway } from "../test/telegram-gateway";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let server: Server;
let base: string;
let realDb: Connection;
let service: TelegramService;
let gateways: FakeGateway[];

beforeAll(async () => {
  await connectTestDb();
  realDb = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await telegramLinkModel(realDb).deleteMany({});
  await telegramMessageModel(realDb).deleteMany({});
  gateways = [];
  service = new TelegramService({
    config: { apiId: 1, apiHash: "hash", sessionKey: randomBytes(32).toString("base64"), botUsername: "Jotihunt_bot" },
    connection: realDb,
    gateway: () => {
      const gateway = new FakeGateway();
      gateways.push(gateway);
      return gateway;
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await service.start();
  setTelegramService(service);
});
afterEach(async () => {
  setTelegramService(null);
  await service.stop();
});
afterAll(async () => {
  server.close();
  await realDb.close();
  await disconnectTestDb();
});

let counter = 0;
const createUser = (admin = false) => User.create({ email: `tg${++counter}@test.nl`, name: admin ? "Admin" : "Hunter", password: "x", admin, requiresPasswordChange: false });
const tokenOf = (user: { _id: unknown }) => jwt.sign({ _id: user._id }, process.env.JWT_SECRET!, { expiresIn: "1h" });

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

describe("/admin/telegram", () => {
  test("admins only", async () => {
    const user = tokenOf(await createUser());
    expect((await request("/admin/telegram")).status).toBe(401);
    expect((await request("/admin/telegram", { token: user })).status).toBe(403);
    expect((await request("/admin/telegram/link", { method: "POST", token: user })).status).toBe(403);
    expect((await request("/admin/telegram/link", { method: "DELETE", token: user })).status).toBe(403);
    expect((await request("/admin/telegram/password", { method: "POST", token: user, json: { password: "x" } })).status).toBe(403);
  });

  test("link by QR with 2FA, then unlink", async () => {
    const admin = tokenOf(await createUser(true));
    expect(await (await request("/admin/telegram", { token: admin })).json()).toEqual({ state: "unlinked" });

    const link = await request("/admin/telegram/link", { method: "POST", token: admin });
    expect(link.status).toBe(200);
    expect(await link.json()).toMatchObject({ state: "qr", url: "tg://login?token=abc" });

    gateways[0].qr.resolve("password");
    let status: { state: string; hint?: string } = { state: "" };
    for (let i = 0; i < 100 && status.state !== "password"; i++) status = (await (await request("/admin/telegram", { token: admin })).json()) as typeof status;
    expect(status).toEqual({ state: "password", hint: "naam van de hond" });

    const empty = await request("/admin/telegram/password", { method: "POST", token: admin, json: {} });
    expect(empty.status).toBe(400);
    const wrong = await request("/admin/telegram/password", { method: "POST", token: admin, json: { password: "fout" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ message: "Wachtwoord klopt niet." });
    const right = await request("/admin/telegram/password", { method: "POST", token: admin, json: { password: "geheim" } });
    expect(await right.json()).toMatchObject({ state: "linked", account: { name: "Silke", phoneMasked: "+31 6 ••• 12" } });

    const unlink = await request("/admin/telegram/link", { method: "DELETE", token: admin });
    expect(unlink.status).toBe(204);
    expect(await (await request("/admin/telegram", { token: admin })).json()).toEqual({ state: "unlinked" });
  });

  test("without a Telegram service: unavailable", async () => {
    setTelegramService(null);
    const admin = tokenOf(await createUser(true));
    expect(await (await request("/admin/telegram", { token: admin })).json()).toEqual({ state: "unavailable" });
    expect((await request("/admin/telegram/link", { method: "POST", token: admin })).status).toBe(503);
  });

  test("the manual counter-hunt alert is gone", async () => {
    const admin = tokenOf(await createUser(true));
    expect((await request("/admin/counter-hunt", { method: "POST", token: admin, json: { direction: 90 } })).status).toBe(404);
  });
});

describe("user routes", () => {
  test("/telegram/messages for any logged-in user", async () => {
    const user = tokenOf(await createUser());
    expect((await request("/telegram/messages")).status).toBe(401);
    await service.handleMessage({ id: 1, senderUsername: "Jotihunt_bot", text: "Je hunt is afgekeurd", date: new Date("2026-10-17T19:14:00Z") });
    const response = await request("/telegram/messages?limit=10", { token: user });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: false, messages: [{ id: "1", text: "Je hunt is afgekeurd", kind: "hunt-rejected", receivedAt: "2026-10-17T19:14:00.000Z" }] });
    expect((await request("/telegram/messages?limit=0", { token: user })).status).toBe(400);
  });

  test("/counter-hunt for any logged-in user", async () => {
    const user = tokenOf(await createUser());
    expect((await request("/counter-hunt")).status).toBe(401);
    expect(await (await request("/counter-hunt", { token: user })).json()).toEqual({ active: false });
    await service.handleMessage({ id: 2, senderUsername: "Jotihunt_bot", text: "Tegenhunt uit het zuiden", date: new Date() });
    expect(await AppNotification.countDocuments()).toBe(1);
    expect(await (await request("/counter-hunt", { token: user })).json()).toMatchObject({ active: true, direction: 180 });
  });
});
