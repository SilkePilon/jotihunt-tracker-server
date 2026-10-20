import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Request, Response } from "express";
import { openTestSettingsStore, type TestSettingsStore } from "../test/settings-store";
import { validate } from "../middleware/validate.middleware";
import { initHuntableAreas, resetHuntableAreas } from "./huntable-areas-setting";
import { huntableAreasValidation } from "./huntable-areas.validation";

// The controller imports the logger from the app entry point, which would start the server
const infoLogs: string[] = [];
mock.module("../logger", () => ({ logger: { info: (message: string) => infoLogs.push(message), error() {}, warn() {}, debug() {} } }));
const { getHuntableAreasSetting, putHuntableAreasSetting } = await import("./settings.controller");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let store: TestSettingsStore;

beforeAll(async () => {
  store = await openTestSettingsStore(uri);
});
beforeEach(async () => {
  await store.connection.collection("settings").deleteMany({});
  resetHuntableAreas();
  infoLogs.length = 0;
});
afterAll(async () => {
  await store.connection.collection("settings").deleteMany({});
  await store.close();
});

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown } as { statusCode: number; body: unknown; status(code: number): typeof res; json(body: unknown): typeof res };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}
const call = async (handler: (req: Request, res: Response) => unknown, req: Record<string, unknown> = {}) => {
  const res = fakeRes();
  await handler({ body: {}, params: {}, ...req } as unknown as Request, res as unknown as Response);
  return res;
};
async function runValidation(body: unknown) {
  const res = fakeRes();
  let passed = false;
  await validate(huntableAreasValidation)({ body } as unknown as Request, res as unknown as Response, () => {
    passed = true;
  });
  return { passed, res, messages: ((res.body as { errors?: { msg: string }[] } | undefined)?.errors ?? []).map((error) => error.msg) };
}

describe("PUT /settings/huntable-areas validation", () => {
  test("accepts a list of known areas, also empty and with duplicates", async () => {
    expect((await runValidation({ areas: ["alpha", "oscar"] })).passed).toBe(true);
    expect((await runValidation({ areas: [] })).passed).toBe(true);
    expect((await runValidation({ areas: ["bravo", "bravo"] })).passed).toBe(true);
  });

  test("rejects a missing or non-list body with a Dutch message", async () => {
    for (const body of [{}, { areas: "alpha" }, { areas: null }]) {
      const { passed, res, messages } = await runValidation(body);
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(messages).toContain("Areas moet een lijst met deelgebieden zijn.");
    }
  });

  test("rejects unknown areas, other casing and non-strings", async () => {
    for (const areas of [["zulu"], ["Alpha"], [1], ["alpha", ""]]) {
      const { passed, messages } = await runValidation({ areas });
      expect(passed).toBe(false);
      expect(messages[0]).toStartWith("Onbekend deelgebied");
    }
  });
});

describe("huntable areas controller", () => {
  test("GET reports null while not configured", async () => {
    await initHuntableAreas(store);
    expect((await call(getHuntableAreasSetting)).body).toEqual({ areas: null });
  });

  test("PUT stores deduplicated and sorted, logs who, and GET reports it", async () => {
    await initHuntableAreas(store);
    const res = await call(putHuntableAreasSetting, { body: { areas: ["golf", "bravo", "golf"] }, user: { name: "Sanne", _id: "1" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ areas: ["bravo", "golf"] });
    expect(infoLogs).toContain("Huntable areas set to bravo, golf by Sanne");
    expect((await call(getHuntableAreasSetting)).body).toEqual({ areas: ["bravo", "golf"] });
  });

  test("PUT with an empty list logs (none)", async () => {
    await initHuntableAreas(store);
    const res = await call(putHuntableAreasSetting, { body: { areas: [] }, user: { _id: "7" } });
    expect(res.body).toEqual({ areas: [] });
    expect(infoLogs).toContain("Huntable areas set to (none) by 7");
  });
});
