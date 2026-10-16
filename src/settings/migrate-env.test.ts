import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { adminConfig, initAppConfig, resetAppConfig, setGeneral } from "./app-config";
import { migrateEnvSettings } from "./migrate-env";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
let connection: Connection;
beforeAll(async () => {
  connection = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await connection.collection("settings").deleteMany({});
  resetAppConfig();
});
afterAll(async () => {
  await connection.collection("settings").deleteMany({});
  await connection.close();
  resetAppConfig();
});

const ENV = { SETTINGS_KEY: KEY, GROUP_NAME: "Env", HOME_TEAM_API_ID: "12", GROUP_CAR_ID: "3", HUNT_START_TIME: "2026-10-17T10:00:00+02:00", GEMINI_API_KEY: "AIza-env-key-123", GEMINI_MODEL: "flash-x", JOTIHUNT_WEB_USERNAME: "u", JOTIHUNT_WEB_PASSWORD: "p", TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "h" };

test("copies env values into the DB without overwriting DB values; second run is a no-op", async () => {
  await initAppConfig(connection, ENV);
  await setGeneral({ groupName: "Db" }, null);
  const first = await migrateEnvSettings("migration");
  expect(first.copied).toContain("homeTeamApiId");
  expect(first.copied).toContain("geminiApiKey");
  expect(first.copied).not.toContain("groupName");
  expect(first.copied).not.toContain("logoUrl");
  const view = adminConfig();
  expect(view.general.groupName).toEqual({ value: "Db", source: "db" });
  expect(view.general.homeTeamApiId).toEqual({ value: 12, source: "db" });
  expect(view.general.vehicleGroups.source).toBe("db");
  expect(view.ai.ocr).toEqual({ value: "flash-x", source: "db" });
  expect(view.secrets.geminiApiKey.source).toBe("db");
  expect(view.plain.telegramApiId).toEqual({ value: "1", source: "db" });
  // After the env vars are gone the values stay
  resetAppConfig();
  await initAppConfig(connection, { SETTINGS_KEY: KEY });
  expect(adminConfig().general.homeTeamApiId.value).toBe(12);
  expect((await migrateEnvSettings("migration")).copied).toEqual([]);
});

test("vehicle groups partly stored: the env-only vehicles are copied, stored ones kept", async () => {
  await initAppConfig(connection, { GROUP_CAR_ID: "3", GROUP_BIKE_ID: "4", GROUP_WALKING_ID: "5" });
  await setGeneral({ vehicleGroups: { walking: 9 } }, null);
  expect(adminConfig().general.vehicleGroups.source).toBe("db");
  const result = await migrateEnvSettings("migration");
  expect(result.copied).toEqual(expect.arrayContaining(["vehicleGroups.car", "vehicleGroups.bike"]));
  expect(result.copied).not.toContain("vehicleGroups.walking");
  resetAppConfig();
  await initAppConfig(connection, {});
  expect(adminConfig().general.vehicleGroups.value).toEqual({ walking: 9, bike: 4, car: 3, motorcycle: null });
});

test("without SETTINGS_KEY secrets are skipped, the rest is copied", async () => {
  await initAppConfig(connection, { ...ENV, SETTINGS_KEY: "" });
  const result = await migrateEnvSettings("migration");
  expect(result.skippedSecrets).toEqual(["geminiApiKey", "jotihuntWebPassword", "telegramApiHash"]);
  expect(result.copied).toContain("groupName");
});
