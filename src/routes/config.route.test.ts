import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose, { type Connection } from "mongoose";
import { User } from "../models/user.model";
import { initAppConfig, resetAppConfig } from "../settings/app-config";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const uploads = mkdtempSync(path.join(tmpdir(), "config-route-"));
process.env.UPLOADS_DIR = uploads;
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let server: Server;
let base: string;
let db: Connection;
let admin: { _id: unknown };
let member: { _id: unknown };

beforeAll(async () => {
  await connectTestDb();
  db = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await db.collection("settings").deleteMany({});
  resetAppConfig();
  await initAppConfig(db, { SETTINGS_KEY: KEY, GROUP_NAME: "Env-groep" });
  admin = await withSession(await User.create({ name: "Admin", admin: true }));
  member = await withSession(await User.create({ name: "Lid", admin: false }));
});
afterAll(async () => {
  server.close();
  resetAppConfig();
  await db.collection("settings").deleteMany({});
  await db.close();
  await disconnectTestDb();
  rmSync(uploads, { recursive: true, force: true });
});

const as = (user: { _id: unknown }, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tokenFor(user)}` } });
const json = (user: { _id: unknown }, method: string, body: unknown) => as(user, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("GET /config", () => {
  test("public, no login needed", async () => {
    const res = await fetch(`${base}/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupName: "Env-groep", logoUrl: "/logo.svg" });
  });
});

describe("admin config", () => {
  test("members get 403", async () => {
    expect((await fetch(`${base}/admin/config`, as(member))).status).toBe(403);
  });

  test("PUT general saves and shows source db; validation errors are Dutch 400s", async () => {
    const ok = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { groupName: "Wolfsheuvel", huntStart: "2026-10-17T09:00:00+02:00", huntEnd: "2026-10-18T15:00:00+02:00", vehicleGroups: { car: 3 } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.general.groupName).toEqual({ value: "Wolfsheuvel", source: "db" });
    expect(body.general.vehicleGroups.value.car).toBe(3);
    const bad = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { huntStart: "2026-10-18T10:00:00Z", huntEnd: "2026-10-17T10:00:00Z" }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("Einde moet na de start liggen.");
    const badUrl = await fetch(`${base}/admin/config/general`, json(admin, "PUT", { discordUrl: "javascript:alert(1)" }));
    expect(badUrl.status).toBe(400);
  });

  test("secrets: saved, never echoed, cleared", async () => {
    const put = await fetch(`${base}/admin/config/secrets/geminiApiKey`, json(admin, "PUT", { value: "AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ" }));
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    expect(JSON.parse(text).secrets.geminiApiKey).toEqual({ set: true, hint: "AIza…fZ", source: "db" });
    expect((await fetch(`${base}/admin/config/secrets/nope`, json(admin, "PUT", { value: "x" }))).status).toBe(400);
    const del = await fetch(`${base}/admin/config/secrets/geminiApiKey`, as(admin, { method: "DELETE" }));
    expect((await del.json()).secrets.geminiApiKey.set).toBe(false);
  });

  test("logo upload is served publicly and sets logoUrl", async () => {
    const form = new FormData();
    form.append("logo", new Blob([PNG], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/admin/config/logo`, as(admin, { method: "POST", body: form }));
    expect(res.status).toBe(200);
    expect((await res.json()).general.logoUrl.value).toStartWith("/branding/logo?v=");
    const logo = await fetch(`${base}/branding/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/png");
  });

  test("logo upload rejects non-images", async () => {
    const form = new FormData();
    form.append("logo", new Blob([Buffer.from("hello")], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/admin/config/logo`, as(admin, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("Kies een PNG-, JPG-, WebP- of SVG-afbeelding.");
  });
});
