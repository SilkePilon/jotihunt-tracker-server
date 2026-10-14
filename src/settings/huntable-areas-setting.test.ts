import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openDemoStateStore, type DemoStateStore } from "../demo/demo-state";
import { getHuntableAreas, initHuntableAreas, normalizeAreas, resetHuntableAreas, setHuntableAreas, type HuntableAreasStore } from "./huntable-areas-setting";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let store: DemoStateStore;

beforeAll(async () => {
  store = await openDemoStateStore(uri);
});
beforeEach(async () => {
  await store.connection.collection("settings").deleteMany({});
  resetHuntableAreas();
});
afterAll(async () => {
  await store.connection.collection("settings").deleteMany({});
  await store.close();
});

describe("normalizeAreas", () => {
  test("known areas only, without duplicates, sorted", () => {
    expect(normalizeAreas(["oscar", "bravo", "bravo", "alpha"])).toEqual(["alpha", "bravo", "oscar"]);
    expect(normalizeAreas(["zulu", "Bravo"])).toEqual([]);
    expect(normalizeAreas([])).toEqual([]);
  });
});

describe("huntable areas setting store and cache", () => {
  test("defaults to null (not configured) without a document", async () => {
    expect(await initHuntableAreas(store)).toBeNull();
    expect(getHuntableAreas()).toBeNull();
  });

  test("write persists in the settings collection, then caches", async () => {
    await initHuntableAreas(store);
    expect(await setHuntableAreas(["delta", "bravo", "delta"], "Sanne")).toEqual(["bravo", "delta"]);
    expect(getHuntableAreas()).toEqual(["bravo", "delta"]);
    const doc = await store.connection.collection("settings").findOne({ key: "huntable-areas" });
    expect(doc).toMatchObject({ key: "huntable-areas", areas: ["bravo", "delta"], updatedBy: "Sanne" });
    expect(doc?.updatedAt).toBeInstanceOf(Date);
    // A restart reads the saved value; the cache is not re-read on every call
    resetHuntableAreas();
    expect(await initHuntableAreas(store)).toEqual(["bravo", "delta"]);
    await store.connection.collection("settings").updateOne({ key: "huntable-areas" }, { $set: { areas: ["echo"] } });
    expect(getHuntableAreas()).toEqual(["bravo", "delta"]);
  });

  test("an empty list is configured (every other area forbidden), not null", async () => {
    await initHuntableAreas(store);
    expect(await setHuntableAreas([], null)).toEqual([]);
    resetHuntableAreas();
    expect(await initHuntableAreas(store)).toEqual([]);
  });

  test("does not touch the demo or prediction documents", async () => {
    await store.write({ enabled: true, enabledAt: null, enabledBy: null, startedAt: null });
    await store.writePrediction({ enabled: false, updatedAt: null, updatedBy: null });
    await initHuntableAreas(store);
    await setHuntableAreas(["alpha"], null);
    expect((await store.read())?.enabled).toBe(true);
    expect((await store.readPrediction())?.enabled).toBe(false);
  });

  test("a failed write leaves the cache unchanged", async () => {
    const failing: HuntableAreasStore = {
      readHuntableAreas: async () => ({ key: "huntable-areas", areas: ["bravo"] }),
      writeHuntableAreas: async () => {
        throw new Error("database down");
      },
    };
    await initHuntableAreas(failing);
    await expect(setHuntableAreas(["charlie"], null)).rejects.toThrow("database down");
    expect(getHuntableAreas()).toEqual(["bravo"]);
  });

  test("writing without init throws", async () => {
    await expect(setHuntableAreas(["alpha"], null)).rejects.toThrow();
  });
});
