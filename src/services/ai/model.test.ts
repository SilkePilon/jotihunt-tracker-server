import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose, { type Connection } from "mongoose";
import { initAppConfig, resetAppConfig, setAiModels, setSecret } from "../../settings/app-config";
import { aiAvailable, aiModel, DEFAULT_GEMINI_MODEL, DEFAULT_PREDICTION_MODEL, requireAiModel } from "./model";
import { GeminiError } from "./gemini-error";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const id = (model: unknown) => (model as { modelId: string }).modelId;
let connection: Connection;

beforeAll(async () => {
  connection = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await connection.collection("settings").deleteMany({});
  resetAppConfig();
});
afterAll(async () => {
  resetAppConfig();
  await connection.close();
});

describe("aiModel", () => {
  test("defaults", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(DEFAULT_PREDICTION_MODEL).toBe("gemini-pro-latest");
  });

  test("no key means no models; requireAiModel throws a GeminiError", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "  " });
    expect(aiAvailable()).toBe(false);
    expect(aiModel("ocr")).toBeNull();
    expect(() => requireAiModel("ocr")).toThrow(GeminiError);
  });

  test("each slot gets its model; a key or model saved in Beheer applies at once", async () => {
    await initAppConfig(connection, { GEMINI_API_KEY: "k", SETTINGS_KEY: KEY });
    expect(id(aiModel("split"))).toBe("gemini-3.8-flash");
    expect(id(aiModel("deep"))).toBe("gemini-pro-latest");
    await setAiModels({ split: "gemini-3.8-flash-lite" }, null);
    expect(id(aiModel("split"))).toBe("gemini-3.8-flash-lite");
    await setSecret("geminiApiKey", "other", null);
    expect(aiAvailable()).toBe(true);
  });
});
