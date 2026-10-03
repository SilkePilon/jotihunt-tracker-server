import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../logger";
import { traccarHttp } from "./traccar-http";
import { clearTraccarCache, getDevices, getGroups, getPositions } from "./traccar.service";

let mode = "ok";
const hits: Record<string, number> = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    await Bun.sleep(20);
    if (mode === "nulls") return Response.json([null, { id: 1, name: "dev1", deviceId: 1 }, 3]);
    if (mode === "wrongshape") return Response.json({ data: [] });
    if (path === "/api/devices") return Response.json([{ id: 1, name: "dev1", groupId: 1 }]);
    if (path === "/api/positions") return Response.json([{ id: 10, deviceId: 1, latitude: 52, longitude: 5 }]);
    if (path === "/api/groups") return Response.json([{ id: 1, name: "Lopend" }]);
    return new Response("?", { status: 404 });
  },
});
const originalBaseUrl = traccarHttp.defaults.baseURL;

beforeAll(() => {
  traccarHttp.defaults.baseURL = `http://127.0.0.1:${server.port}`;
  spyOn(logger, "error").mockImplementation((() => undefined) as never);
});
beforeEach(() => {
  mode = "ok";
  for (const key of Object.keys(hits)) delete hits[key];
  clearTraccarCache();
});
afterAll(() => {
  mock.restore();
  traccarHttp.defaults.baseURL = originalBaseUrl;
  server.stop(true);
});

describe("Traccar lists", () => {
  test("concurrent polls share one fetch per list", async () => {
    await Promise.all(Array.from({ length: 20 }, () => Promise.all([getPositions(), getDevices(), getGroups()])));
    expect(hits).toEqual({ "/api/devices": 1, "/api/positions": 1, "/api/groups": 1 });
    expect((await getPositions())[0]).toMatchObject({ id: 10, deviceName: "dev1" });
  });

  test("a failed fetch is not cached", async () => {
    mode = "wrongshape";
    await expect(getPositions()).rejects.toThrow("Could not fetch");
    mode = "ok";
    expect(await getPositions()).toHaveLength(1);
  });

  test("null and non-object entries are skipped instead of failing", async () => {
    mode = "nulls";
    expect(await getDevices()).toEqual([{ id: 1, name: "dev1", deviceId: 1 } as never]);
    expect(await getPositions()).toHaveLength(1);
  });
});
