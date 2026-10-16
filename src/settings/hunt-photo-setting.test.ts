import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDemoStateStore, type DemoStateStore } from "../demo/demo-state";
import { User } from "../models/user.model";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { initHuntPhotoSetting, isHuntPhotoEnabled, resetHuntPhotoSetting, setHuntPhotoEnabled } from "./hunt-photo-setting";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let store: DemoStateStore;
let server: Server;
let base: string;

beforeAll(async () => {
  await connectTestDb();
  store = await openDemoStateStore(uri);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await store.connection.collection("settings").deleteMany({});
  resetHuntPhotoSetting();
});
afterAll(async () => {
  server.close();
  await store.connection.collection("settings").deleteMany({});
  await store.close();
  await disconnectTestDb();
});

function request(path: string, token: string, json?: unknown) {
  return fetch(`${base}${path}`, {
    method: json === undefined ? "GET" : "PUT",
    headers: { Authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "Content-Type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

describe("hunt photo setting store and cache", () => {
  test("defaults to off without a document", async () => {
    expect(await initHuntPhotoSetting(store)).toBe(false);
    expect(isHuntPhotoEnabled()).toBe(false);
  });

  test("write persists in the settings collection and survives a restart", async () => {
    await initHuntPhotoSetting(store);
    await setHuntPhotoEnabled(true, "Sanne");
    expect(isHuntPhotoEnabled()).toBe(true);
    expect(await store.connection.collection("settings").findOne({ key: "hunt-photo" })).toMatchObject({ key: "hunt-photo", enabled: true, updatedBy: "Sanne" });
    resetHuntPhotoSetting();
    expect(await initHuntPhotoSetting(store)).toBe(true);
  });

  test("writing without init throws", async () => {
    await expect(setHuntPhotoEnabled(true, null)).rejects.toThrow();
  });
});

describe("GET/PUT /settings/hunt-photo", () => {
  test("any user reads it, also the Android app with its device token; only admins change it", async () => {
    await initHuntPhotoSetting(store);
    const hunter = await withSession(await User.create({ name: "Hunter", devices: [{ id: "dev1", name: "Pixel", createdAt: new Date() }] }));
    const admin = await withSession(await User.create({ name: "HQ", admin: true }));
    const device = jwt.sign({ _id: String(hunter._id), did: "dev1", kind: "device" }, process.env.JWT_SECRET!, { expiresIn: "1h" });

    expect(await (await request("/settings/hunt-photo", tokenFor(hunter))).json()).toEqual({ enabled: false });
    expect(await (await request("/settings/hunt-photo", device)).json()).toEqual({ enabled: false });

    expect((await request("/settings/hunt-photo", tokenFor(hunter), { enabled: true })).status).toBe(403);
    expect((await request("/settings/hunt-photo", tokenFor(admin), { enabled: "true" })).status).toBe(400);
    const put = await request("/settings/hunt-photo", tokenFor(admin), { enabled: true });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ enabled: true });
    expect(await (await request("/settings/hunt-photo", device)).json()).toEqual({ enabled: true });
  });

  test("401 without a token", async () => {
    expect((await fetch(`${base}/settings/hunt-photo`)).status).toBe(401);
  });
});
