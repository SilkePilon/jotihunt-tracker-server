import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { dropLegacyHuntCodeIndex, Hunt } from "../models/hunt.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { assignSiteKeys, type ScrapedHunt } from "../services/jotihunt-hunts.parse";
import { HuntSyncEvent } from "../models/hunt-sync-event.model";
import { keepStoredDates, storeHunts } from "./jotihunt-scraper.cron";

const time = new Date("2026-10-17T19:03:00Z");
const web = (code: string | null, overrides: Partial<ScrapedHunt> = {}): ScrapedHunt =>
  assignSiteKeys([{ siteKey: "", area: "Alpha", huntCode: code, status: "approved" as const, statusText: "Goedgekeurd", points: 1, huntTimeText: "21:03", huntTime: time, location: null, ...overrides }])[0];
const hunt = (code: string) => web(code);
const codes = async () => (await Hunt.find().lean()).map((stored) => stored.huntCode).sort();

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("storeHunts", () => {
  test("upserts and drops hunts the website no longer lists", async () => {
    await storeHunts(["A", "B", "C"].map(hunt));
    expect(await storeHunts(["B", "C", "D"].map(hunt))).toMatchObject({ deleted: true });
    expect(await codes()).toEqual(["B", "C", "D"]);
  });

  test("an empty scrape (Cloudflare page, empty table) keeps every stored hunt", async () => {
    await storeHunts(["A", "B", "C"].map(hunt));
    expect(await storeHunts([])).toMatchObject({ deleted: false });
    expect(await codes()).toEqual(["A", "B", "C"]);
  });

  test("a scrape far shorter than what is stored only upserts", async () => {
    await storeHunts(["A", "B", "C", "D", "E", "F"].map(hunt));
    expect(await storeHunts([hunt("G"), hunt("A")])).toMatchObject({ deleted: false });
    expect(await codes()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  test("the site key is unique", async () => {
    const doc = { siteKey: "code:A", area: "alpha", status: "Goedgekeurd", points: 1, updatedAt: time };
    await Hunt.create(doc);
    await expect(Hunt.create(doc)).rejects.toMatchObject({ code: 11000 });
  });

  test("hunts without a code are kept, keyed by area and time, and updated in place", async () => {
    const later = new Date(time.getTime() + 2 * 60 * 60 * 1000);
    await storeHunts([web(null), web(null, { area: "Bravo" }), web(null, { huntTime: later }), web("X")]);
    expect(await Hunt.countDocuments()).toBe(4);
    const first = await Hunt.findOne({ siteKey: `time:alpha:${time.toISOString()}` }).lean();
    expect(first).toMatchObject({ area: "Alpha", huntCode: null, status: "Goedgekeurd" });
    expect(first!.huntTime!.getTime()).toBe(time.getTime());

    await storeHunts([web(null, { statusText: "Afgekeurd", points: 0 }), web(null, { area: "Bravo" }), web(null, { huntTime: later }), web("X")]);
    expect(await Hunt.countDocuments()).toBe(4);
    expect(await Hunt.findById(first!._id).lean()).toMatchObject({ status: "Afgekeurd", points: 0 });
  });

  test("the same fox at the same time twice in one scrape: both kept", async () => {
    const stored = assignSiteKeys([web(null), web(null)]);
    expect(stored.map((entry) => entry.siteKey)).toEqual([`time:alpha:${time.toISOString()}`, `time:alpha:${time.toISOString()}#2`]);
    await storeHunts(stored);
    expect(await Hunt.countDocuments()).toBe(2);
  });

  test("a time the site shows in an unknown format keys by the raw text", () => {
    expect([web(null, { huntTime: null, huntTimeText: "gisteren" })][0]).toMatchObject({ siteKey: "raw:alpha:gisteren", huntTime: null });
  });

  test("the old unique code index is dropped on its own, without a sync; hunts without a code then never collide", async () => {
    await Hunt.collection.createIndex({ huntCode: 1 }, { unique: true });
    expect(await dropLegacyHuntCodeIndex()).toBe(true);
    expect((await Hunt.collection.indexes()).some((index) => index.name === "huntCode_1")).toBe(false);
    await storeHunts([web(null), web(null, { area: "Bravo" })]);
    expect(await Hunt.countDocuments({ huntCode: null })).toBe(2);
  });

  test("dropping the old index on a database without hunts is a no-op", async () => {
    await Hunt.collection.drop().catch(() => undefined);
    expect(await dropLegacyHuntCodeIndex()).toBe(false);
    await Hunt.createIndexes();
  });

  test("a clock-only time keeps the date it was stored with (Saturday rows on Sunday morning)", async () => {
    const saturday = new Date("2026-10-17T07:15:00Z");
    await storeHunts([web(null, { huntTimeText: "09:15", huntTime: saturday }), web("C", { area: "Charlie", huntTimeText: "09:15", huntTime: saturday })]);
    const sunday = new Date("2026-10-18T07:15:00Z");
    const rescraped = [web(null, { huntTimeText: "09:15", huntTime: sunday }), web("C", { area: "Charlie", huntTimeText: "09:15", huntTime: sunday }), web(null, { area: "Bravo", huntTimeText: "09:15", huntTime: sunday }), web(null, { huntTimeText: "2026-10-18 09:15", huntTime: sunday })];
    await keepStoredDates(rescraped, new Date(saturday.getTime() + 17 * 60 * 60_000));
    expect(rescraped.map((hunt) => hunt.huntTime)).toEqual([saturday, saturday, sunday, sunday]);
  });

  test("a stored date older than 18 hours is another day's hunt: the clock time keeps its own date", async () => {
    const saturday = new Date("2026-10-17T07:15:00Z");
    await storeHunts([web(null, { huntTimeText: "09:15", huntTime: saturday })]);
    const sunday = new Date("2026-10-18T07:15:00Z");
    const rescraped = [web(null, { huntTimeText: "09:15", huntTime: sunday })];
    await keepStoredDates(rescraped, new Date(saturday.getTime() + 19 * 60 * 60_000));
    expect(rescraped[0].huntTime).toEqual(sunday);
    expect(rescraped[0].siteKey).toBe(`time:alpha:${sunday.toISOString()}`);
  });

  test("hunts from before siteKey with a blank code are not given a key (no clashing 'code:' keys)", async () => {
    await Hunt.collection.insertMany([
      { area: "Alpha", huntCode: " ", status: "Goedgekeurd", points: 1, huntTime: time, updatedAt: time },
      { area: "Bravo", huntCode: "", status: "Goedgekeurd", points: 1, huntTime: time, updatedAt: time },
      { area: "Charlie", huntCode: " K ", status: "Goedgekeurd", points: 1, huntTime: time, updatedAt: time },
    ]);
    await storeHunts([web("Z", { area: "Delta" })]);
    const keys = (await Hunt.collection.find({}, { projection: { _id: 0, area: 1, siteKey: 1 } }).toArray()).map((entry) => [entry.area, entry.siteKey ?? null]);
    expect(keys).toEqual(expect.arrayContaining([["Alpha", null], ["Bravo", null], ["Charlie", "code:K"]]));
  });

  test("migrates a database from before siteKey: old unique code index dropped, old hunts kept and updated", async () => {
    // The old layout: unique huntCode, no siteKey
    await Hunt.collection.dropIndexes();
    await Hunt.collection.createIndex({ huntCode: 1 }, { unique: true });
    const old = await Hunt.collection.insertOne({ area: "Alpha", huntCode: "A", status: "Goedgekeurd", points: 6, huntTime: time, updatedAt: time });
    await Hunt.collection.insertOne({ area: "Bravo", huntCode: "B", status: "Goedgekeurd", points: 3, huntTime: time, updatedAt: time });
    // What maintainIndexes does at startup: drop the old index on its own, then sync
    expect(await dropLegacyHuntCodeIndex()).toBe(true);
    expect(await dropLegacyHuntCodeIndex()).toBe(false);
    await Hunt.syncIndexes();
    expect((await Hunt.collection.indexes()).map((index) => index.name).sort()).toEqual(["_id_", "siteKey_1"]);

    expect(await storeHunts([web("A", { statusText: "Afgekeurd" }), web("B"), web(null), web(null, { area: "Charlie" })])).toMatchObject({ deleted: true });
    expect(await Hunt.countDocuments()).toBe(4);
    expect(await Hunt.findById(old.insertedId).lean()).toMatchObject({ siteKey: "code:A", status: "Afgekeurd" });
  });
});

describe("storeHunts: synced fields and the sync log", () => {
  const location = { lat: 52.0123, lng: 5.9876, accuracy: 12 };
  const coded = (code: string, overrides: Partial<ScrapedHunt> = {}) => web(code, { area: "alpha", status: "pending", statusText: "Wacht op bevestiging", points: 0, ...overrides });
  const now = new Date("2026-10-17T19:50:00Z");
  const later = new Date("2026-10-17T19:51:00Z");

  test("stores status class, text, hunt code, location and first-seen time", async () => {
    await storeHunts([coded("A", { location })], now);
    expect(await Hunt.findOne({ siteKey: "code:A" }).lean()).toMatchObject({ statusClass: "pending", statusText: "Wacht op bevestiging", status: "Wacht op bevestiging", huntCode: "A", location, firstSeenAt: now, statusChangedAt: null });
  });

  test("a single new hunt logs 'new' with the hunt's id, time and location", async () => {
    const { events, initial } = await storeHunts([coded("A", { location })], now);
    expect(initial).toBe(false);
    const stored = await Hunt.findOne({ siteKey: "code:A" }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "new", area: "alpha", siteKey: "code:A", points: null, at: now, huntTime: time, location, initial: false });
    expect(String(events[0].huntId)).toBe(String(stored!._id));
  });

  test("approval: an 'approved' event with points and statusChangedAt", async () => {
    await storeHunts([coded("A"), coded("B")], now);
    const { events } = await storeHunts([coded("A", { status: "approved", statusText: "Goedgekeurd", points: 10 }), coded("B")], later);
    expect(events.map(({ type, siteKey, points }) => ({ type, siteKey, points }))).toEqual([{ type: "approved", siteKey: "code:A", points: 10 }]);
    expect(await Hunt.findOne({ siteKey: "code:A" }).lean()).toMatchObject({ statusClass: "approved", points: 10, statusChangedAt: later, firstSeenAt: now });
    expect(await HuntSyncEvent.countDocuments()).toBe(3);
  });

  test("the first import into an empty database is flagged initial and logs only 'new'", async () => {
    const { events, initial } = await storeHunts([coded("A", { status: "approved", points: 10 }), coded("B", { status: "rejected" })], now);
    expect(initial).toBe(true);
    expect(events.map(({ type, initial }) => [type, initial])).toEqual([
      ["new", true],
      ["new", true],
    ]);
  });

  test("a scrape without a location keeps the stored one", async () => {
    await storeHunts([coded("A", { location })], now);
    await storeHunts([coded("A")], later);
    expect((await Hunt.findOne({ siteKey: "code:A" }).lean())!.location).toMatchObject(location);
  });

  test("hunts older than the page's oldest row are kept (a 'last N hunts' list), newer missing ones are dropped", async () => {
    const at = (minutes: number) => new Date(time.getTime() + minutes * 60_000);
    await storeHunts([coded("OLD", { huntTime: at(-120) }), coded("A", { huntTime: at(0) }), coded("B", { huntTime: at(10) }), coded("C", { huntTime: at(20) })], now);
    const { deleted, removed } = await storeHunts([coded("A", { huntTime: at(0) }), coded("C", { huntTime: at(20) }), coded("D", { huntTime: at(30) })], later);
    expect(deleted).toBe(true);
    expect(removed).toEqual(["code:B"]);
    expect((await Hunt.find().lean()).map((hunt) => hunt.siteKey).sort()).toEqual(["code:A", "code:C", "code:D", "code:OLD"]);
  });
});

describe("storeHunts: stable keys and safe deletes (review fixes)", () => {
  const now = new Date("2026-10-17T19:50:00Z");
  const later = new Date("2026-10-17T19:51:00Z");
  const at = (minutes: number) => new Date(time.getTime() + minutes * 60_000);
  const pending = (overrides: Partial<ScrapedHunt>) => web(null, { area: "alpha", status: "pending", statusText: "Wacht op bevestiging", points: 0, ...overrides });

  test("re-dating a clock-only time re-keys only time-based keys", async () => {
    const saturday = new Date("2026-10-17T07:15:00Z");
    await storeHunts([pending({ huntTimeText: "09:15", huntTime: saturday })], now);
    const sunday = new Date("2026-10-18T07:15:00Z");
    const timeKeyed = pending({ huntTimeText: "09:15", huntTime: sunday });
    const codeKeyed = pending({ huntTimeText: "09:15", huntTime: sunday, huntCode: "Q1" });
    await keepStoredDates([timeKeyed, codeKeyed], new Date(saturday.getTime() + 60 * 60_000));
    expect(timeKeyed.siteKey).toBe(`time:alpha:${saturday.toISOString()}`);
    expect(codeKeyed.siteKey).toBe("code:Q1");
  });

  test("a stored hunt under another key (same fox, time within 1 min) is re-keyed, not logged again", async () => {
    await storeHunts([pending({ huntTime: at(0) }), pending({ area: "bravo", huntTime: at(5) })], now);
    expect(await HuntSyncEvent.countDocuments()).toBe(2);
    const rekeyed = pending({ huntTime: at(0.5), huntCode: "QA", status: "approved", statusText: "Goedgekeurd", points: 10 });
    const { events } = await storeHunts([rekeyed, pending({ area: "bravo", huntTime: at(5) })], later);
    expect(events.map(({ type, siteKey }) => [type, siteKey])).toEqual([["approved", "code:QA"]]);
    expect(await Hunt.countDocuments()).toBe(2);
    expect(await Hunt.findOne({ siteKey: "code:QA" }).lean()).toMatchObject({ statusClass: "approved", firstSeenAt: now });
  });

  test("flapping through unknown does not log the outcome again", async () => {
    await storeHunts([pending({ huntCode: "A" }), pending({ huntCode: "B", area: "bravo" })], now);
    await storeHunts([pending({ huntCode: "A", status: "approved", points: 10 }), pending({ huntCode: "B", area: "bravo" })], now);
    await storeHunts([pending({ huntCode: "A", status: "unknown", statusText: "", points: 0 }), pending({ huntCode: "B", area: "bravo" })], now);
    const { events } = await storeHunts([pending({ huntCode: "A", status: "approved", points: 10 }), pending({ huntCode: "B", area: "bravo" })], now);
    expect(events).toEqual([]);
    expect(await Hunt.findOne({ siteKey: "code:A" }).lean()).toMatchObject({ lastNotifiedOutcome: "approved", lastNotifiedPoints: 10 });
  });

  test("the delete window uses known times only; hunts without a time are never dropped by it", async () => {
    await storeHunts([pending({ huntCode: "A", huntTime: at(0) }), pending({ huntCode: "B", huntTime: at(10) }), pending({ huntCode: "N", huntTime: null, huntTimeText: "?" })], now);
    const { removed } = await storeHunts([pending({ huntCode: "A", huntTime: at(0) }), pending({ huntCode: "C", huntTime: null, huntTimeText: "?" })], later);
    expect(removed).toEqual(["code:B"]);
    expect((await Hunt.find().lean()).map((hunt) => hunt.siteKey).sort()).toEqual(["code:A", "code:C", "code:N"]);
  });

  test("a row the parser skipped: nothing is deleted (its hunt would look gone)", async () => {
    await storeHunts([pending({ huntCode: "A", huntTime: at(0) }), pending({ huntCode: "B", huntTime: at(10) })], now);
    const result = await storeHunts([pending({ huntCode: "A", huntTime: at(0) })], later, { skipped: 1 });
    expect(result).toMatchObject({ deleted: false, removed: [] });
    expect(await Hunt.countDocuments()).toBe(2);
  });

  test("a row whose time could not be read (raw: key): nothing is deleted", async () => {
    await storeHunts([pending({ huntTime: at(0) }), pending({ huntCode: "B", huntTime: at(10) })], now);
    const result = await storeHunts([pending({ huntTime: null, huntTimeText: "kwart over" }), pending({ huntCode: "B", huntTime: at(10) })], later);
    expect(result).toMatchObject({ deleted: false, removed: [] });
    expect(await Hunt.countDocuments()).toBe(3);
  });

  test("re-keying matches areas case-insensitively without a regex (special characters are text)", async () => {
    await storeHunts([pending({ area: "a.c", huntTime: at(0) })], now);
    await storeHunts([pending({ area: "A.C", huntTime: at(0.5), huntCode: "Q1" }), pending({ area: "abc", huntTime: at(0.2), huntCode: "Q2" })], later);
    expect((await Hunt.find().lean()).map((entry) => entry.siteKey).sort()).toEqual(["code:Q1", "code:Q2"]);
    expect(await Hunt.findOne({ siteKey: "code:Q1" }).lean()).toMatchObject({ firstSeenAt: now });
  });

  test("no readable time on the page: nothing is deleted", async () => {
    await storeHunts([pending({ huntCode: "A", huntTime: at(0) }), pending({ huntCode: "B", huntTime: at(10) })], now);
    const result = await storeHunts([pending({ huntCode: "C", huntTime: null, huntTimeText: "?" }), pending({ huntCode: "D", huntTime: null, huntTimeText: "?" })], later);
    expect(result).toMatchObject({ deleted: false, removed: [] });
    expect(await Hunt.countDocuments()).toBe(4);
  });
});
