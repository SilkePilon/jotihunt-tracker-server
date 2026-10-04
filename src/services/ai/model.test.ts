import { describe, expect, test } from "bun:test";
import { createModels, DEFAULT_GEMINI_MODEL, DEFAULT_PREDICTION_MODEL } from "./model";

const id = (model: unknown) => (model as { modelId: string }).modelId;

describe("createModels", () => {
  test("defaults", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(DEFAULT_PREDICTION_MODEL).toBe("gemini-pro-latest");
  });

  test("no key (or a blank one) means no models", () => {
    expect(createModels({})).toBeNull();
    expect(createModels({ GEMINI_API_KEY: "   " })).toBeNull();
  });

  test("each purpose gets its default model", () => {
    const models = createModels({ GEMINI_API_KEY: "k" })!;
    expect(id(models("ocr"))).toBe("gemini-3.8-flash");
    expect(id(models("summary"))).toBe("gemini-3.8-flash");
    expect(id(models("chat"))).toBe("gemini-3.8-flash");
    expect(id(models("prediction"))).toBe("gemini-pro-latest");
  });

  test("environment variables override the defaults; summary follows GEMINI_MODEL", () => {
    const models = createModels({ GEMINI_API_KEY: "k", GEMINI_MODEL: " flash-x ", GEMINI_PREDICTION_MODEL: "pro-x", GEMINI_CHAT_MODEL: "chat-x" })!;
    expect(id(models("ocr"))).toBe("flash-x");
    expect(id(models("summary"))).toBe("flash-x");
    expect(id(models("prediction"))).toBe("pro-x");
    expect(id(models("chat"))).toBe("chat-x");
  });

  test("a blank override falls back to the default", () => {
    const models = createModels({ GEMINI_API_KEY: "k", GEMINI_MODEL: " " })!;
    expect(id(models("ocr"))).toBe("gemini-3.8-flash");
  });
});
