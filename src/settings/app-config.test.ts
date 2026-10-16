import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { ServiceError } from "../http/service-error";
import {
  adminConfig,
  aiModelId,
  general,
  initAppConfig,
  onAppConfigChange,
  plain,
  publicConfig,
  resetAppConfig,
  secret,
  setAiModels,
  setGeneral,
  setPlain,
  setSecret,
  settingsKeyOk,
} from "./app-config";

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
});

describe("resolution DB → env → default", () => {
  test("defaults without env or DB", async () => {
    await initAppConfig(connection, {});
    expect(general("logoUrl")).toEqual({ value: "/logo.svg", source: "default" });
    expect(general("groupName")).toEqual({ value: null, source: "default" });
    expect(general("vehicleGroups")).toEqual({ value: { walking: null, bike: null, car: null, motorcycle: null }, source: "default" });
    expect(aiModelId("ocr")).toEqual({ value: "gemini-3.8-flash", source: "default" });
    expect(aiModelId("deep")).toEqual({ value: "gemini-pro-latest", source: "default" });
    expect(secret("geminiApiKey")).toBeNull();
  });

  test("env fills in when the DB has nothing", async () => {
    await initAppConfig(connection, {
      HOME_TEAM_API_ID: "12",
      GROUP_NAME: " Wolfsheuvel ",
      HUNT_START_TIME: "2026-10-17T10:00:00+02:00",
      GROUP_CAR_ID: "3",
      GEMINI_MODEL: "flash-x",
      GEMINI_CHAT_MODEL: "chat-x",
      GEMINI_PREDICTION_MODEL: "pro-x",
      GEMINI_API_KEY: "env-key",
      TELEGRAM_BOT_USERNAME: "@Other_bot",
    });
    expect(general("homeTeamApiId")).toEqual({ value: 12, source: "env" });
    expect(general("groupName")).toEqual({ value: "Wolfsheuvel", source: "env" });
    expect(general("huntStart")).toEqual({ value: "2026-10-17T08:00:00.000Z", source: "env" });
    expect(general("vehicleGroups").value.car).toBe(3);
    expect(general("vehicleGroups").source).toBe("env");
    expect(aiModelId("split")).toEqual({ value: "flash-x", source: "env" });
    expect(aiModelId("tools")).toEqual({ value: "chat-x", source: "env" });
    expect(aiModelId("deep")).toEqual({ value: "pro-x", source: "env" });
    expect(secret("geminiApiKey")).toBe("env-key");
    expect(plain("telegramBotUsername")).toBe("Other_bot");
  });

  test("DB wins over env and survives a restart; null clears back to env", async () => {
    await initAppConfig(connection, { GROUP_NAME: "Env", GEMINI_MODEL: "flash-x" });
    await setGeneral({ groupName: "Db", vehicleGroups: { walking: 1 } }, "Sanne");
    await setAiModels({ ocr: "gemini-3.8-pro" }, "Sanne");
    expect(general("groupName")).toEqual({ value: "Db", source: "db" });
    expect(aiModelId("ocr")).toEqual({ value: "gemini-3.8-pro", source: "db" });
    expect(aiModelId("summary").source).toBe("env");
    resetAppConfig();
    await initAppConfig(connection, { GROUP_NAME: "Env" });
    expect(general("groupName").value).toBe("Db");
    expect(general("vehicleGroups").value.walking).toBe(1);
    await setGeneral({ groupName: null }, "Sanne");
    expect(general("groupName")).toEqual({ value: "Env", source: "env" });
    await setAiModels({ ocr: null }, null);
    expect(aiModelId("ocr").source).toBe("default");
  });
});

describe("secrets", () => {
  test("stored encrypted; never in the admin view; env fallback after clearing", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY, GEMINI_API_KEY: "env-key" });
    expect(settingsKeyOk()).toBe(true);
    await setSecret("geminiApiKey", "AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ", "Sanne");
    expect(secret("geminiApiKey")).toBe("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    const raw = JSON.stringify(await connection.collection("settings").findOne({ key: "app-config" }));
    expect(raw).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    const view = adminConfig();
    expect(JSON.stringify(view)).not.toContain("AIzaSyD4k9Qe1v7Xw2LmT0pR8sN3bH6cY5uJfZ");
    expect(view.secrets.geminiApiKey).toEqual({ set: true, hint: "AIza…fZ", source: "db" });
    await setSecret("geminiApiKey", null, "Sanne");
    expect(secret("geminiApiKey")).toBe("env-key");
    expect(adminConfig().secrets.geminiApiKey).toEqual({ set: true, hint: "env-…ey", source: "env" });
  });

  test("passwords get a fixed hint", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    await setSecret("jotihuntWebPassword", "geheim", null);
    expect(adminConfig().secrets.jotihuntWebPassword.hint).toBe("••••••••");
  });

  test("writing without a valid SETTINGS_KEY is a 409", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: "short" });
    expect(settingsKeyOk()).toBe(false);
    const error = await setSecret("geminiApiKey", "x", null).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ code: "settings_key_missing" });
  });

  test("a secret stored with another key reads as unset (falls back to env)", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    await setSecret("geminiApiKey", "db-key", null);
    resetAppConfig();
    await initAppConfig(connection, { SETTINGS_KEY: Buffer.alloc(32, 9).toString("base64"), GEMINI_API_KEY: "env-key" });
    expect(secret("geminiApiKey")).toBe("env-key");
  });
});

describe("plain credentials, public view and change events", () => {
  test("plain values resolve like general ones", async () => {
    await initAppConfig(connection, { JOTIHUNT_WEB_USERNAME: "env-user" });
    expect(plain("jotihuntWebUsername")).toBe("env-user");
    await setPlain({ jotihuntWebUsername: "db-user", telegramApiId: "2451873" }, null);
    expect(plain("jotihuntWebUsername")).toBe("db-user");
    expect(adminConfig().plain.telegramApiId).toEqual({ value: "2451873", source: "db" });
  });

  test("public config has no sources and no secrets", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "k", HUNT_END_TIME: "2026-10-18T12:00:00+02:00", DISCORD_URL: "https://discord.gg/x" });
    expect(publicConfig()).toEqual({
      groupName: null,
      logoUrl: "/logo.svg",
      discordUrl: "https://discord.gg/x",
      huntStart: null,
      huntEnd: "2026-10-18T10:00:00.000Z",
      homeTeamApiId: null,
      vehicleGroups: { walking: null, bike: null, car: null, motorcycle: null },
    });
  });

  test("listeners hear which part changed", async () => {
    await initAppConfig(connection, { SETTINGS_KEY: KEY });
    const heard: string[] = [];
    const off = onAppConfigChange((part) => heard.push(part));
    await setGeneral({ groupName: "x" }, null);
    await setAiModels({ chat: "m" }, null);
    await setSecret("telegramApiHash", "h", null);
    await setPlain({ telegramApiId: "1" }, null);
    off();
    await setGeneral({ groupName: "y" }, null);
    expect(heard).toEqual(["general", "ai", "secrets", "secrets"]);
  });
});
