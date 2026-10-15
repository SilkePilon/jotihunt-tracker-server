import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { buildingTileModel } from "../models/building-tile.model";
import { BuildingsUpstreamError, type BuildingsApi } from "./buildings.client";
import { tileBounds, tileId, tileOf, tilesAround, type Bounds, type RawBuildingPart } from "./buildings.helpers";
import { BuildingsService } from "./buildings.service";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };
const TILE = tileOf(5.9005, 51.9805);

/** One building in the middle of whatever bounds are asked; fails for bounds in `failing`; resolves on release() when held. */
class FakeApi implements BuildingsApi {
  calls: Bounds[] = [];
  failing = new Set<string>();
  height = 20;
  hold = false;
  private waiters: (() => void)[] = [];
  active = 0;
  maxActive = 0;

  release() {
    this.hold = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async fetchParts(bounds: Bounds): Promise<RawBuildingPart[]> {
    this.calls.push(bounds);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) await new Promise<void>((resolve) => this.waiters.push(resolve));
      else await Bun.sleep(1);
      if (this.failing.has(`${bounds.west},${bounds.north}`)) throw new BuildingsUpstreamError("down");
      const lon = (bounds.west + bounds.east) / 2;
      const lat = (bounds.south + bounds.north) / 2;
      const d = (bounds.east - bounds.west) / 10;
      return [
        {
          geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] },
          properties: { b3_h_70p: 10 + this.height, b3_h_maaiveld: 10 },
        },
      ];
    } finally {
      this.active--;
    }
  }
}

const key = (b: Bounds) => `${b.west},${b.north}`;
let db: Connection;
let api: FakeApi;
let clock: Date;
let service: BuildingsService;

beforeAll(async () => {
  db = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  // A failed test's job can't leak into the next one
  await service?.idle();
  await buildingTileModel(db).deleteMany({});
  api = new FakeApi();
  clock = new Date("2026-10-15T12:00:00Z");
  service = new BuildingsService({ connection: db, client: api, logger: silent, now: () => clock });
});
afterAll(async () => {
  await db.close();
});

describe("getTile", () => {
  test("miss fetches and caches, hit doesn't fetch again", async () => {
    const first = await service.getTile(TILE);
    expect(first).toBeInstanceOf(Buffer);
    expect(api.calls).toHaveLength(1);
    const doc = await buildingTileModel(db).findById(tileId(TILE));
    expect(doc?.count).toBe(1);
    const second = await service.getTile(TILE);
    expect(Buffer.compare(first!, second!)).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  test("empty tile is cached as null", async () => {
    api.height = -5;
    expect(await service.getTile(TILE)).toBeNull();
    expect(await service.getTile(TILE)).toBeNull();
    expect(api.calls).toHaveLength(1);
    expect((await buildingTileModel(db).findById(tileId(TILE)))?.count).toBe(0);
  });

  test("outside NL: null without fetching", async () => {
    expect(await service.getTile(tileOf(2.35, 48.85))).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  test("upstream error throws and caches nothing", async () => {
    api.failing.add(key(tileBounds(TILE)));
    await expect(service.getTile(TILE)).rejects.toBeInstanceOf(BuildingsUpstreamError);
    expect(await buildingTileModel(db).countDocuments()).toBe(0);
  });

  test("parallel requests for one tile share one fetch", async () => {
    const results = await Promise.all([service.getTile(TILE), service.getTile(TILE), service.getTile(TILE)]);
    expect(api.calls).toHaveLength(1);
    expect(results.every((r) => r instanceof Buffer)).toBe(true);
  });

  test("at most maxParallel upstream fetches at once", async () => {
    service = new BuildingsService({ connection: db, client: api, logger: silent, maxParallel: 2 });
    const tiles = tilesAround(51.98, 5.9, 2).slice(0, 6);
    await Promise.all(tiles.map((tile) => service.getTile(tile)));
    expect(api.calls).toHaveLength(6);
    expect(api.maxActive).toBe(2);
  });
});

describe("jobs", () => {
  test("prefetch fetches the missing tiles of the radius and reports progress", async () => {
    await service.getTile(TILE);
    const expected = tilesAround(51.9805, 5.9005, 1);
    const started = await service.startPrefetch(51.9805, 5.9005, 1);
    expect(started.job).toMatchObject({ kind: "prefetch", total: expected.length - 1, done: 0, failed: 0, finishedAt: null });
    await service.idle();
    const status = await service.status();
    expect(status.job).toMatchObject({ kind: "prefetch", done: expected.length - 1, failed: 0 });
    expect(status.job?.finishedAt).not.toBeNull();
    expect(status.tiles).toBe(expected.length);
    expect(status.buildings).toBe(expected.length);
    expect(status.bytes).toBeGreaterThan(0);
  });

  test("refresh re-fetches every cached tile, oldest first; a failure keeps the old tile", async () => {
    const [a, b] = tilesAround(51.98, 5.9, 1);
    await service.getTile(a);
    clock = new Date("2026-10-15T13:00:00Z");
    await service.getTile(b);
    api.calls = [];
    api.failing.add(key(tileBounds(b)));
    clock = new Date("2026-10-15T14:00:00Z");
    await service.startRefresh();
    await service.idle();
    expect(api.calls.map(key)).toEqual([key(tileBounds(a)), key(tileBounds(b))]);
    const status = await service.status();
    expect(status.job).toMatchObject({ kind: "refresh", total: 2, done: 2, failed: 1 });
    expect(status.tiles).toBe(2);
    expect(status.oldest).toBe("2026-10-15T13:00:00.000Z");
    expect(status.newest).toBe("2026-10-15T14:00:00.000Z");
  });

  test("one job at a time; clear refused while running", async () => {
    api.hold = true;
    await service.startPrefetch(51.98, 5.9, 1);
    await expect(service.startRefresh()).rejects.toMatchObject({ status: 409 });
    await expect(service.startPrefetch(51.98, 5.9, 1)).rejects.toMatchObject({ status: 409 });
    await expect(service.clear()).rejects.toMatchObject({ status: 409 });
    api.release();
    await service.idle();
  });

  test("map requests go ahead of job fetches", async () => {
    service = new BuildingsService({ connection: db, client: api, logger: silent, maxParallel: 1 });
    api.hold = true;
    await service.startPrefetch(51.98, 5.9, 2);
    await Bun.sleep(5);
    const far = tileOf(6.5, 52.5);
    const map = service.getTile(far);
    // Let the map request do its cache lookup and get queued before the job's first fetch finishes
    await Bun.sleep(20);
    api.release();
    await map;
    // The map tile was the second upstream call (right after the job's first, already running)
    expect(key(api.calls[1])).toBe(key(tileBounds(far)));
    await service.idle();
  });

  test("a map request for a tile the job has queued overtakes the job's other tiles", async () => {
    service = new BuildingsService({ connection: db, client: api, logger: silent, maxParallel: 1 });
    api.hold = true;
    await service.startPrefetch(51.98, 5.9, 2);
    await Bun.sleep(5);
    const queued = tilesAround(51.98, 5.9, 2)[5];
    const map = service.getTile(queued);
    // Let the map request do its cache lookup and join the queued job fetch before the first fetch finishes
    await Bun.sleep(20);
    api.release();
    expect(await map).toBeInstanceOf(Buffer);
    expect(key(api.calls[1])).toBe(key(tileBounds(queued)));
    await service.idle();
    expect(api.calls.filter((b) => key(b) === key(tileBounds(queued)))).toHaveLength(1);
    expect((await service.status()).job).toMatchObject({ done: tilesAround(51.98, 5.9, 2).length, failed: 0 });
  });

  test("a failing fetch hands its slot to the next waiter", async () => {
    service = new BuildingsService({ connection: db, client: api, logger: silent, maxParallel: 1 });
    const tiles = tilesAround(51.98, 5.9, 1);
    api.failing.add(key(tileBounds(tiles[0])));
    await service.startPrefetch(51.98, 5.9, 1);
    await service.idle();
    expect((await service.status()).job).toMatchObject({ total: tiles.length, done: tiles.length, failed: 1 });
    expect(api.calls).toHaveLength(tiles.length);
    expect(await buildingTileModel(db).countDocuments()).toBe(tiles.length - 1);
  });

  test("two parallel starts: one runs, the other gets 409", async () => {
    const results = await Promise.allSettled([service.startPrefetch(51.98, 5.9, 1), service.startPrefetch(51.98, 5.9, 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ status: 409 });
    await service.idle();
  });

  test("radius is validated", async () => {
    await expect(service.startPrefetch(51.98, 5.9, 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.startPrefetch(51.98, 5.9, 26)).rejects.toMatchObject({ status: 400 });
  });

  test("clear deletes all tiles", async () => {
    await service.getTile(TILE);
    const status = await service.clear();
    expect(status.tiles).toBe(0);
    expect(status.oldest).toBeNull();
  });
});
