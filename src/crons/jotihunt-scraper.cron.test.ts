import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hunt } from "../models/hunt.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { storeHunts } from "./jotihunt-scraper.cron";

const hunt = (code: string) => ({ area: "Alpha", status: "Goedgekeurd", huntCode: code, points: 1, huntTime: new Date(), updatedAt: new Date() });
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

  test("the hunt code is unique", async () => {
    await Hunt.create(hunt("A"));
    await expect(Hunt.create(hunt("A"))).rejects.toMatchObject({ code: 11000 });
  });
});
