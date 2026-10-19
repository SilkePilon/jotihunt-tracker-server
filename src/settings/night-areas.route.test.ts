import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { validationResult } from "express-validator";
import { openDemoStateStore, type DemoStateStore } from "../demo/demo-state";

mock.module("../logger", () => ({ logger: { info() {}, error() {}, warn() {}, debug() {} } }));
const { getNightAreasSetting, putNightAreasSetting } = await import("./settings.controller");
const { initNightAreas, nightAreasHash, resetNightAreas, getRoutesSetting } = await import("./night-areas-setting");
const { nightAreasValidation } = await import("./night-areas.validation");

const URI = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let store: DemoStateStore;
function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(body: unknown) { res.body = body; return res; } };
  return res;
}
const square = { type: "Polygon" as const, coordinates: [[[5.8, 52], [5.81, 52], [5.81, 52.01], [5.8, 52]]] };

async function check(body: unknown) {
  const req = { body } as never;
  for (const v of nightAreasValidation) await v.run(req);
  return validationResult(req).isEmpty();
}

beforeAll(async () => { store = await openDemoStateStore(URI); });
beforeEach(async () => { await store.connection.collection("settings").deleteMany({}); resetNightAreas(); await initNightAreas(store); });
afterAll(async () => { await store.connection.collection("settings").deleteMany({}); resetNightAreas(); await store.close(); });

describe("night areas setting", () => {
  test("defaults to enabled with no areas", () => {
    const res = fakeRes();
    getNightAreasSetting({} as never, res as never);
    expect(res.body).toEqual({ enabled: true, areas: [] });
    expect(nightAreasHash()).toBe("");
  });

  test("put persists, survives a reload and changes the hash", async () => {
    const res = fakeRes();
    await putNightAreasSetting({ body: { enabled: false, areas: [{ id: "a1", name: "Posbank noord", kind: "closed", polygon: square, extra: 1 }] }, user: { name: "Silke" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(getRoutesSetting().areas[0]).toEqual({ id: "a1", name: "Posbank noord", kind: "closed", polygon: square });
    const hash = nightAreasHash();
    expect(hash).toHaveLength(16);
    resetNightAreas();
    await initNightAreas(store);
    expect(getRoutesSetting().enabled).toBe(false);
    expect(nightAreasHash()).toBe(hash);
  });

  test("validation", async () => {
    expect(await check({ enabled: true, areas: [{ id: "a", name: "X", kind: "open", polygon: square }] })).toBe(true);
    expect(await check({ enabled: true, areas: [{ id: "a", name: "X", kind: "open", polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] } }] })).toBe(false);
    expect(await check({ enabled: "yes", areas: [] })).toBe(false);
  });

  test("a self-intersecting ring is rejected with its own message", async () => {
    const bowTie = { type: "Polygon", coordinates: [[[5.8, 52], [5.81, 52.01], [5.81, 52], [5.8, 52.01], [5.8, 52]]] };
    const req = { body: { enabled: true, areas: [{ id: "a", name: "X", kind: "open", polygon: bowTie }] } } as never;
    for (const v of nightAreasValidation) await v.run(req);
    expect(validationResult(req).array().map((e) => e.msg)).toEqual(["Gebied mag zichzelf niet kruisen."]);
    const square4 = { type: "Polygon", coordinates: [[[5.8, 52], [5.81, 52], [5.81, 52.01], [5.8, 52.01], [5.8, 52]]] };
    expect(await check({ enabled: true, areas: [{ id: "a", name: "X", kind: "open", polygon: square4 }] })).toBe(true);
  });
});
