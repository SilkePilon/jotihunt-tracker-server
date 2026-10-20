import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Request, Response } from "express";
import { openControlStore, type ControlStore } from "../editions/control-store";
import { initPredictionSetting, isPredictionEnabled, resetPredictionSetting, setPredictionEnabled } from "./prediction-setting";

// The controllers and the cron import the logger from the app entry point, which would start the server
const infoLogs: string[] = [];
mock.module("../logger", () => ({ logger: { info: (message: string) => infoLogs.push(message), error() {}, warn() {}, debug() {} } }));
const recomputeDue = mock(async () => ({ recomputed: ["alpha"], failed: [] as { area: string; error: unknown }[] }));
mock.module("../services/prediction/instance", () => ({ predictionService: { recomputeDue, recomputeArea: mock(async () => {}) }, walkMinutes: mock(async () => ({ minutes: [], estimate: true })) }));
const { getPredictions } = await import("../controllers/predictions.controller");
const { getVisits, putVisit } = await import("../controllers/visits.controller");
const { putPredictionSetting, getPredictionSetting } = await import("./settings.controller");
const { default: recomputePredictions } = await import("../crons/prediction.cron");

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let store: ControlStore;

beforeAll(async () => {
  store = await openControlStore(uri);
});
beforeEach(async () => {
  await store.connection.collection("settings").deleteMany({});
  resetPredictionSetting();
  infoLogs.length = 0;
  recomputeDue.mockClear();
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

describe("prediction setting store and cache", () => {
  test("defaults to enabled without a document", async () => {
    expect(await initPredictionSetting(store)).toBe(true);
    expect(isPredictionEnabled()).toBe(true);
  });

  test("write persists in the settings collection and updates the cache", async () => {
    await initPredictionSetting(store);
    await setPredictionEnabled(false, "Sanne");
    expect(isPredictionEnabled()).toBe(false);
    const doc = await store.connection.collection("settings").findOne({ key: "prediction" });
    expect(doc).toMatchObject({ key: "prediction", enabled: false, updatedBy: "Sanne" });
    expect(doc?.updatedAt).toBeInstanceOf(Date);
    // A restart reads the saved value; the cache is not re-read on every call
    resetPredictionSetting();
    expect(await initPredictionSetting(store)).toBe(false);
    await store.connection.collection("settings").updateOne({ key: "prediction" }, { $set: { enabled: true } });
    expect(isPredictionEnabled()).toBe(false);
  });

  test("does not touch the demo document", async () => {
    await store.write({ enabled: true, enabledAt: null, enabledBy: null, startedAt: null });
    await initPredictionSetting(store);
    await setPredictionEnabled(false, null);
    expect((await store.read())?.enabled).toBe(true);
  });

  test("writing without init throws", async () => {
    await expect(setPredictionEnabled(false, null)).rejects.toThrow();
  });
});

describe("when the prediction is disabled", () => {
  test("PUT /settings/prediction switches, logs and GET reports it", async () => {
    await initPredictionSetting(store);
    const res = await call(putPredictionSetting, { body: { enabled: false }, user: { name: "Sanne", _id: "1" } });
    expect(res.body).toEqual({ enabled: false });
    expect(infoLogs).toContain("Fox prediction disabled by Sanne");
    expect((await call(getPredictionSetting)).body).toEqual({ enabled: false });
  });

  test("predictions and visits are empty, PUT visit is 409", async () => {
    await initPredictionSetting(store);
    await setPredictionEnabled(false, null);
    expect((await call(getPredictions)).body).toEqual([]);
    expect((await call(getVisits)).body).toEqual([]);
    const res = await call(putVisit, { params: { teamApiId: "1" }, body: { state: "visited" } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: "AI-voorspelling staat uit." });
  });

  test("the cron does nothing when disabled and runs when enabled", async () => {
    await initPredictionSetting(store);
    await setPredictionEnabled(false, null);
    await recomputePredictions();
    expect(recomputeDue).not.toHaveBeenCalled();
    await setPredictionEnabled(true, null);
    await recomputePredictions();
    expect(recomputeDue).toHaveBeenCalledTimes(1);
  });
});
