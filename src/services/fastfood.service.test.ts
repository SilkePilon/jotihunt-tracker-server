process.env.TZ = "Europe/Amsterdam";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { fastfoodModel } from "../models/fastfood.model";
import { FastfoodUpstreamError, type FastfoodApi } from "./fastfood.client";
import type { OverpassElement } from "./fastfood.helpers";
import { FastfoodService } from "./fastfood.service";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const silent = { info() {}, warn() {}, error() {} };

const element = (id: number, hours?: string): OverpassElement => ({
  type: "node",
  id,
  lat: 52 + id / 1000,
  lon: 5,
  tags: { "brand:wikidata": "Q38076", ...(hours ? { opening_hours: hours } : {}) },
});

class FakeApi implements FastfoodApi {
  elements: OverpassElement[] = [];
  fail = false;
  calls = 0;
  async fetchElements() {
    this.calls++;
    if (this.fail) throw new FastfoodUpstreamError("down");
    return this.elements;
  }
}

let db: Connection;
let api: FakeApi;
let clock: Date;
let service: FastfoodService;

beforeAll(async () => {
  db = await mongoose.createConnection(uri).asPromise();
  await fastfoodModel(db).syncIndexes();
});
beforeEach(async () => {
  await fastfoodModel(db).deleteMany({});
  api = new FakeApi();
  clock = new Date("2026-10-17T23:40:00+02:00");
  service = new FastfoodService({ connection: db, client: api, logger: silent, now: () => clock, minCount: 2 });
});
afterAll(async () => {
  service.stop();
  await db.close();
});

describe("refresh", () => {
  test("stores the restaurants, skipping unusable elements", async () => {
    api.elements = [element(1), element(2), { type: "node", id: 3, tags: { "brand:wikidata": "Q1" }, lat: 1, lon: 1 }];
    expect(await service.refresh()).toBe(true);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });

  test("a second refresh updates and drops restaurants that are gone", async () => {
    api.elements = [element(1), element(2), element(3), element(4), element(5)];
    await service.refresh();
    api.elements = [element(1, "24/7"), element(2), element(3), element(5)];
    clock = new Date(clock.getTime() + 1000);
    await service.refresh();
    const docs = await fastfoodModel(db).find().sort({ osmId: 1 }).lean();
    expect(docs.map((doc) => doc.osmId)).toEqual(["node/1", "node/2", "node/3", "node/5"]);
    expect(docs[0].openingHours).toBe("24/7");
  });

  test("Overpass down keeps the old data", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    api.fail = true;
    expect(await service.refresh()).toBe(false);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });

  test("fewer than minCount restaurants is a failure", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    api.elements = [element(1)];
    expect(await service.refresh()).toBe(false);
    expect(await fastfoodModel(db).countDocuments()).toBe(2);
  });

  test("fewer than MIN_KEEP_RATIO of the stored restaurants is a failure", async () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => element(index + 1));
    api.elements = ids(10);
    expect(await service.refresh()).toBe(true);
    api.elements = ids(7);
    expect(await service.refresh()).toBe(false);
    expect(await fastfoodModel(db).countDocuments()).toBe(10);
    api.elements = ids(8);
    expect(await service.refresh()).toBe(true);
    expect(await fastfoodModel(db).countDocuments()).toBe(8);
  });
});

describe("refreshIfStale", () => {
  test("refreshes when empty or a day old, not otherwise", async () => {
    api.elements = [element(1), element(2)];
    await service.refreshIfStale();
    expect(api.calls).toBe(1);
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await service.refreshIfStale();
    expect(api.calls).toBe(1);
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    await service.refreshIfStale();
    expect(api.calls).toBe(2);
  });
});

describe("start", () => {
  test("a failing background check is logged, not left unhandled", async () => {
    const errors: string[] = [];
    const logged = new FastfoodService({ connection: db, client: api, logger: { ...silent, error: (message: string) => errors.push(message) } });
    logged.refreshIfStale = () => Promise.reject(new Error("mongo down"));
    logged.start();
    logged.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Fastfood refresh check failed");
    expect(errors[0]).toContain("mongo down");
  });
});

describe("list", () => {
  test("adds intervals from now; unknown hours have none", async () => {
    api.elements = [element(1, "Mo-Su 10:00-01:00"), element(2)];
    await service.refresh();
    const items = await service.list();
    const open = items.find((item) => item.osmId === "node/1")!;
    // Saturday 23:40: the open interval Sat 10:00 – Sun 01:00, cut at "now" by getOpenIntervals
    expect(open.intervals?.[0]).toEqual({ start: "2026-10-17T21:40:00.000Z", end: "2026-10-17T23:00:00.000Z" });
    expect(open).not.toHaveProperty("_id");
    expect(typeof open.updatedAt).toBe("string");
    expect(items.find((item) => item.osmId === "node/2")).not.toHaveProperty("intervals");
  });

  test("is cached for 10 minutes", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    expect(await service.list()).toHaveLength(2);
    await fastfoodModel(db).deleteOne({ osmId: "node/1" });
    expect(await service.list()).toHaveLength(2);
    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    expect(await service.list()).toHaveLength(1);
  });

  test("a refresh clears the cache", async () => {
    api.elements = [element(1), element(2)];
    await service.refresh();
    expect(await service.list()).toHaveLength(2);
    api.elements = [element(1), element(2), element(3)];
    await service.refresh();
    expect(await service.list()).toHaveLength(3);
  });
});
