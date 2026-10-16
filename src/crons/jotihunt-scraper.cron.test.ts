import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hunt } from "../models/hunt.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import type { WebHunt } from "../types/api";
import { storeHunts, toStoredHunts } from "./jotihunt-scraper.cron";

const time = new Date("2026-10-17T19:03:00Z");
const web = (code: string | null, overrides: Partial<WebHunt> = {}): WebHunt => ({ area: "Alpha", huntCode: code, status: "Goedgekeurd", points: 1, huntTime: "21:03", time, ...overrides });
const hunt = (code: string) => toStoredHunts([web(code)])[0];
const codes = async () => (await Hunt.find().lean()).map((stored) => stored.huntCode).sort();

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("storeHunts", () => {
  test("upserts and drops hunts the website no longer lists", async () => {
    await storeHunts(["A", "B", "C"].map(hunt));
    expect(await storeHunts(["B", "C", "D"].map(hunt))).toEqual({ deleted: true });
    expect(await codes()).toEqual(["B", "C", "D"]);
  });

  test("an empty scrape (Cloudflare page, empty table) keeps every stored hunt", async () => {
    await storeHunts(["A", "B", "C"].map(hunt));
    expect(await storeHunts([])).toEqual({ deleted: false });
    expect(await codes()).toEqual(["A", "B", "C"]);
  });

  test("a scrape far shorter than what is stored only upserts", async () => {
    await storeHunts(["A", "B", "C", "D", "E", "F"].map(hunt));
    expect(await storeHunts([hunt("G"), hunt("A")])).toEqual({ deleted: false });
    expect(await codes()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  test("the site key is unique", async () => {
    await Hunt.create(hunt("A"));
    await expect(Hunt.create(hunt("A"))).rejects.toMatchObject({ code: 11000 });
  });

  test("hunts without a code are kept, keyed by area and time, and updated in place", async () => {
    const later = new Date(time.getTime() + 2 * 60 * 60 * 1000);
    await storeHunts(toStoredHunts([web(null), web(null, { area: "Bravo" }), web(null, { time: later }), web("X")]));
    expect(await Hunt.countDocuments()).toBe(4);
    const first = await Hunt.findOne({ siteKey: `time:alpha:${time.toISOString()}` }).lean();
    expect(first).toMatchObject({ area: "Alpha", huntCode: null, status: "Goedgekeurd" });
    expect(first!.huntTime!.getTime()).toBe(time.getTime());

    await storeHunts(toStoredHunts([web(null, { status: "Afgekeurd", points: 0 }), web(null, { area: "Bravo" }), web(null, { time: later }), web("X")]));
    expect(await Hunt.countDocuments()).toBe(4);
    expect(await Hunt.findById(first!._id).lean()).toMatchObject({ status: "Afgekeurd", points: 0 });
  });

  test("the same fox at the same time twice in one scrape: both kept", async () => {
    const stored = toStoredHunts([web(null), web(null)]);
    expect(stored.map((entry) => entry.siteKey)).toEqual([`time:alpha:${time.toISOString()}`, `time:alpha:${time.toISOString()}#2`]);
    await storeHunts(stored);
    expect(await Hunt.countDocuments()).toBe(2);
  });

  test("a time the site shows in an unknown format keys by the raw text", () => {
    expect(toStoredHunts([web(null, { time: null, huntTime: "gisteren" })])[0]).toMatchObject({ siteKey: "raw:alpha:gisteren", huntTime: null });
  });

  test("migrates a database from before siteKey: old unique code index dropped, old hunts kept and updated", async () => {
    // The old layout: unique huntCode, no siteKey
    await Hunt.collection.dropIndexes();
    await Hunt.collection.createIndex({ huntCode: 1 }, { unique: true });
    const old = await Hunt.collection.insertOne({ area: "Alpha", huntCode: "A", status: "Goedgekeurd", points: 6, huntTime: time, updatedAt: time });
    await Hunt.collection.insertOne({ area: "Bravo", huntCode: "B", status: "Goedgekeurd", points: 3, huntTime: time, updatedAt: time });
    // What maintainIndexes does at startup
    await Hunt.syncIndexes();
    expect((await Hunt.collection.indexes()).map((index) => index.name).sort()).toEqual(["_id_", "siteKey_1"]);

    expect(await storeHunts(toStoredHunts([web("A", { status: "Afgekeurd" }), web("B"), web(null), web(null, { area: "Charlie" })]))).toEqual({ deleted: true });
    expect(await Hunt.countDocuments()).toBe(4);
    expect(await Hunt.findById(old.insertedId).lean()).toMatchObject({ siteKey: "code:A", status: "Afgekeurd" });
  });
});
