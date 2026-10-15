import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose, { type Connection } from "mongoose";
import { buildingTileModel } from "../models/building-tile.model";
import { User } from "../models/user.model";
import { BuildingsUpstreamError, type BuildingsApi } from "../services/buildings.client";
import { tileOf, type Bounds, type RawBuildingPart } from "../services/buildings.helpers";
import { BuildingsService, setBuildingsService } from "../services/buildings.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
const TILE = tileOf(5.9005, 51.9805);

class FakeApi implements BuildingsApi {
  fail = false;
  empty = false;
  /** A 20x20 grid of buildings, so the tile is over compression's 1 KB threshold */
  many = false;
  /** While set, fetches wait for it (keeps a job running) */
  gate: Promise<void> | null = null;
  async fetchParts(b: Bounds): Promise<RawBuildingPart[]> {
    if (this.gate) await this.gate;
    if (this.fail) throw new BuildingsUpstreamError("down");
    if (this.empty) return [];
    if (this.many) {
      const step = (b.east - b.west) / 20;
      const dy = (b.north - b.south) / 20;
      return Array.from({ length: 400 }, (_, i) => {
        const lon = b.west + (i % 20) * step;
        const lat = b.south + Math.floor(i / 20) * dy;
        const ring = [[lon, lat], [lon + step / 2, lat], [lon + step / 2, lat + dy / 2], [lon, lat + dy / 2], [lon, lat]];
        return { geometry: { type: "Polygon", coordinates: [ring] }, properties: { b3_h_70p: 20 + (i % 7), b3_h_maaiveld: 10 } };
      });
    }
    const lon = (b.west + b.east) / 2;
    const lat = (b.south + b.north) / 2;
    const d = (b.east - b.west) / 10;
    return [{ geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] }, properties: { b3_h_70p: 30, b3_h_maaiveld: 10 } }];
  }
}

let server: Server;
let base: string;
let db: Connection;
let api: FakeApi;
let service: BuildingsService;

beforeAll(async () => {
  await connectTestDb();
  db = await mongoose.createConnection(uri).asPromise();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await buildingTileModel(db).deleteMany({});
  api = new FakeApi();
  service = new BuildingsService({ connection: db, client: api, logger: silent });
  setBuildingsService(service);
});
afterEach(async () => {
  await service.idle();
  setBuildingsService(null);
});
afterAll(async () => {
  server.close();
  await db.close();
  await disconnectTestDb();
});

const createUser = async (admin = false) => withSession(await User.create({ name: admin ? "Admin" : "Hunter", admin }));

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

const tilePath = (x = TILE.x, y = TILE.y, z = 15) => `/buildings/${z}/${x}/${y}.pbf`;

describe("GET /buildings/15/:x/:y.pbf", () => {
  test("needs a login", async () => {
    expect((await request(tilePath())).status).toBe(401);
  });

  test("returns the vector tile", async () => {
    const token = tokenFor(await createUser());
    const res = await request(tilePath(), { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-protobuf");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("a tile over 1 KB is gzipped", async () => {
    api.many = true;
    const token = tokenFor(await createUser());
    const res = await request(tilePath(), { token, headers: { "Accept-Encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1024);
  });

  test("empty tile: 204", async () => {
    api.empty = true;
    const token = tokenFor(await createUser());
    expect((await request(tilePath(), { token })).status).toBe(204);
  });

  test("bad zoom or tile: 400", async () => {
    const token = tokenFor(await createUser());
    expect((await request(tilePath(TILE.x, TILE.y, 14), { token })).status).toBe(400);
    expect((await request(tilePath(99999, 1), { token })).status).toBe(400);
    expect((await request("/buildings/15/abc/1.pbf", { token })).status).toBe(400);
  });

  test("3DBAG down: 502", async () => {
    api.fail = true;
    const token = tokenFor(await createUser());
    expect((await request(tilePath(), { token })).status).toBe(502);
  });
});

describe("admin routes", () => {
  const ADMIN_ROUTES: [string, string, unknown?][] = [
    ["GET", "/admin/buildings"],
    ["POST", "/admin/buildings/refresh"],
    ["POST", "/admin/buildings/prefetch", { lat: 51.98, lon: 5.9, radiusKm: 1 }],
    ["DELETE", "/admin/buildings"],
  ];

  test("non-admins get 403", async () => {
    const token = tokenFor(await createUser(false));
    for (const [method, path, json] of ADMIN_ROUTES) expect((await request(path, { method, token, json })).status).toBe(403);
  });

  test("status, prefetch, clear", async () => {
    const token = tokenFor(await createUser(true));
    const empty = await (await request("/admin/buildings", { token })).json();
    expect(empty).toMatchObject({ tiles: 0, buildings: 0, job: null });

    let release = () => {};
    api.gate = new Promise<void>((resolve) => (release = resolve));
    const started = await request("/admin/buildings/prefetch", { method: "POST", token, json: { lat: 51.98, lon: 5.9, radiusKm: 1 } });
    expect(started.status).toBe(202);
    expect((await started.json()).job.kind).toBe("prefetch");
    expect((await request("/admin/buildings/refresh", { method: "POST", token })).status).toBe(409);
    release();
    await service.idle();

    const status = await (await request("/admin/buildings", { token })).json();
    expect(status.tiles).toBeGreaterThan(0);

    const cleared = await request("/admin/buildings", { method: "DELETE", token });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).tiles).toBe(0);
  });

  test("prefetch body is validated", async () => {
    const token = tokenFor(await createUser(true));
    for (const json of [{}, { lat: 51.98, lon: 5.9 }, { lat: "x", lon: 5.9, radiusKm: 5 }, { lat: 51.98, lon: 5.9, radiusKm: 30 }]) {
      expect((await request("/admin/buildings/prefetch", { method: "POST", token, json })).status).toBe(400);
    }
  });
});
