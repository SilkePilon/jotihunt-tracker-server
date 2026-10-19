process.env.TZ = "Europe/Amsterdam";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose, { type Connection } from "mongoose";
import { fastfoodModel } from "../models/fastfood.model";
import { User } from "../models/user.model";
import type { FastfoodApi } from "../services/fastfood.client";
import type { OverpassElement } from "../services/fastfood.helpers";
import { FastfoodService, setFastfoodService } from "../services/fastfood.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
const api: FastfoodApi = {
  fetchElements: async (): Promise<OverpassElement[]> => [
    { type: "node", id: 1, lat: 52, lon: 5, tags: { "brand:wikidata": "Q524757", opening_hours: "24/7" } },
    { type: "node", id: 2, lat: 52.1, lon: 5.1, tags: { "brand:wikidata": "Q177054" } },
  ],
};

let server: Server;
let base: string;
let db: Connection;

beforeAll(async () => {
  await connectTestDb();
  db = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await fastfoodModel(db).deleteMany({});
});
afterEach(() => setFastfoodService(null));
afterAll(async () => {
  server.close();
  await db.close();
  await disconnectTestDb();
});

const createUser = async () => withSession(await User.create({ name: "Hunter" }));

describe("GET /fastfood", () => {
  test("needs a login", async () => {
    expect((await fetch(`${base}/fastfood`)).status).toBe(401);
  });

  test("503 without the service", async () => {
    const token = tokenFor(await createUser());
    expect((await fetch(`${base}/fastfood`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(503);
  });

  test("lists the restaurants with intervals", async () => {
    const service = new FastfoodService({ connection: db, client: api, logger: silent, minCount: 1 });
    await service.refresh();
    setFastfoodService(service);
    const token = tokenFor(await createUser());
    const res = await fetch(`${base}/fastfood`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const items = (await res.json()) as { osmId: string; brand: string; intervals?: unknown[] }[];
    expect(items.map((item) => [item.osmId, item.brand]).sort()).toEqual([["node/1", "kfc"], ["node/2", "burgerking"]]);
    expect(items.find((item) => item.osmId === "node/1")!.intervals).toHaveLength(1);
    expect(items.find((item) => item.osmId === "node/2")).not.toHaveProperty("intervals");
  });
});
