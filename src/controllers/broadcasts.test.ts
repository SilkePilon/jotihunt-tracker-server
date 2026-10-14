import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { tokenFor, withSession } from "../test/auth";
import { User } from "../models/user.model";
import { AppNotification } from "../models/notification.model";

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

function request(path: string, token: string, json?: unknown) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { method: json !== undefined ? "POST" : "GET", headers, body: json !== undefined ? JSON.stringify(json) : undefined });
}

describe("GET /admin/broadcasts", () => {
  test("lists only broadcasts, newest first, with sender", async () => {
    const admin = await withSession(await User.create({ name: "Hanneke", admin: true }));
    const token = tokenFor(admin);
    expect((await request("/admin/broadcast", token, { message: "Eerste" })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 5));
    expect((await request("/admin/broadcast", token, { message: "Tweede" })).status).toBe(201);
    await AppNotification.create({ type: "counter-hunt", title: "x", body: "niet dit" });

    const res = await request("/admin/broadcasts", token);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { type: string; body: string; createdAt: string; data: { from: string } }[];
    expect(list.map((n) => n.body)).toEqual(["Tweede", "Eerste"]);
    expect(list.every((n) => n.type === "broadcast" && n.data.from === "Hanneke" && n.createdAt)).toBe(true);
  });

  test("non-admin gets 403", async () => {
    const user = await withSession(await User.create({ name: "Jan", admin: false }));
    expect((await request("/admin/broadcasts", tokenFor(user))).status).toBe(403);
  });
});
