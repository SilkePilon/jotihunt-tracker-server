import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { User } from "../models/user.model";
import { setAuthConnection } from "../auth/auth-db";
import { closeEditions, getControlStore, initEditions } from "../editions/database-switch";
import { mongoUriDbName } from "../editions/mongo-uri";
import { tokenFor, withSession } from "../test/auth";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

/** A switch builds every registered model's indexes on the edition database: more than bun's 5 s default in a full run */
setDefaultTimeout(30_000);

/** A throwaway control database, so this file never touches the test database of the other files */
const baseUri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const name = `jh-editions-route-${Math.random().toString(36).slice(2, 8)}`;
const uri = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/[^?#]*)?/, `$1/${name}`);

let server: Server;
let base: string;
let admin: string;
let hunter: string;

beforeAll(async () => {
  expect(mongoUriDbName(uri)).toBe(name);
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.disconnected) await mongoose.disconnect();
  await initEditions(uri);
  setAuthConnection(getControlStore().connection);
  admin = tokenFor(await withSession(await User.create({ name: "Admin", admin: true })));
  hunter = tokenFor(await withSession(await User.create({ name: "Hunter" })));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  setAuthConnection(null);
  await closeEditions();
  const conn = await mongoose.createConnection(baseUri).asPromise();
  for (const db of [name, `${name}-2027`]) await conn.useDb(db, { useCache: false }).dropDatabase();
  await conn.close();
});

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("/editions", () => {
  test("GET needs a token and lists the editions", async () => {
    expect((await fetch(`${base}/editions`)).status).toBe(401);
    const res = await call("GET", "/editions", hunter);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      editions: [{ year: 2026, live: true, shown: true, huntStart: null, huntEnd: null, hunts: 0, points: null }],
      liveYear: 2026,
      shownYear: 2026,
      readOnly: false,
    });
  });

  test("POST creates the next edition (admins only)", async () => {
    expect((await call("POST", "/editions", hunter)).status).toBe(403);
    const res = await call("POST", "/editions", admin);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.liveYear).toBe(2027);
    expect(view.shownYear).toBe(2027);
    expect(view.readOnly).toBe(false);
    expect(view.editions.map((edition: { year: number }) => edition.year)).toEqual([2027, 2026]);
  });

  test("POST /show shows an archive: read-only, no live trackers", async () => {
    expect((await call("POST", "/editions/show", hunter, { year: 2026 })).status).toBe(403);
    const res = await call("POST", "/editions/show", admin, { year: 2026 });
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view).toMatchObject({ liveYear: 2027, shownYear: 2026, readOnly: true });
    expect(view.editions.find((edition: { year: number }) => edition.year === 2026)).toMatchObject({ live: false, shown: true });

    const write = await call("POST", "/markers", admin, { name: "x" });
    expect(write.status).toBe(423);
    expect(await write.json()).toEqual({ message: "Archief is alleen-lezen" });
    expect((await call("POST", "/teams/reload", admin)).status).toBe(423);
    const devices = await call("GET", "/tracker/devices", hunter);
    expect(devices.status).toBe(200);
    expect(await devices.json()).toEqual([]);
    expect(await (await call("GET", "/tracker/positions", hunter)).json()).toEqual([]);
  });

  test("POST /show validates the year and refuses unknown editions", async () => {
    expect((await call("POST", "/editions/show", admin, { year: 1999 })).status).toBe(400);
    const missing = await call("POST", "/editions/show", admin, { year: 2019 });
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toBe("Die editie bestaat niet");
  });

  test("back to the live edition: writable again", async () => {
    const res = await call("POST", "/editions/show", admin, { year: 2027 });
    expect(res.status).toBe(200);
    expect((await res.json()).readOnly).toBe(false);
  });
});
