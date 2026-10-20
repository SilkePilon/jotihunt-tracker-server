import { afterAll, beforeAll, expect, test } from "bun:test";
import mongoose from "mongoose";
import { editionSettingsStore } from "./edition-settings-store";

/** A throwaway database next to MONGO_URI_TEST (same convention as src/test/db.ts), dropped afterwards. */
const baseUri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const uri = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/[^?#]*)?/, `$1/jh-edset-${Date.now()}`);

beforeAll(async () => {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.disconnected) await mongoose.disconnect();
  await mongoose.connect(uri);
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("reads and writes the settings of the default connection's database", async () => {
  const store = editionSettingsStore();
  expect(await store.readPrediction()).toBeNull();
  await store.writePrediction({ enabled: false, updatedAt: null, updatedBy: null });
  expect((await store.readPrediction())?.enabled).toBe(false);
  await store.writeNightAreas({ enabled: true, areas: [], updatedAt: null, updatedBy: null });
  expect(await mongoose.connection.collection("settings").countDocuments()).toBe(2);
});
