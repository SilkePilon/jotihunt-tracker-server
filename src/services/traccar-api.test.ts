import { describe, expect, test } from "bun:test";
import { createTraccarApi, type HttpClient } from "./traccar-api";

interface Call {
  method: "get" | "post" | "put";
  url: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Fake HTTP client: records every call and answers with the queued responses in order. */
function fakeHttp(responses: unknown[]) {
  const calls: Call[] = [];
  const next = async <T>() => ({ data: responses.shift() as T });
  const http: HttpClient = {
    get: (url, config) => {
      calls.push({ method: "get", url, params: config?.params, headers: config?.headers });
      return next();
    },
    post: (url, body) => {
      calls.push({ method: "post", url, body });
      return next();
    },
    put: (url, body) => {
      calls.push({ method: "put", url, body });
      return next();
    },
  };
  return { http, calls };
}

describe("createTraccarApi", () => {
  test("findDevice queries by uniqueId and returns the exact match or null", async () => {
    const { http, calls } = fakeHttp([[{ id: 4, name: "A", uniqueId: "jh-1" }], []]);
    const api = createTraccarApi(http);
    expect(await api.findDevice("jh-1")).toEqual({ id: 4, name: "A", uniqueId: "jh-1" });
    expect(await api.findDevice("jh-2")).toBeNull();
    expect(calls[0]).toEqual({ method: "get", url: "/api/devices", params: { uniqueId: "jh-1" }, headers: undefined });
  });

  test("getDevice queries by id and returns the exact match or null", async () => {
    const { http, calls } = fakeHttp([[{ id: 4, name: "A", uniqueId: "jh-1" }], []]);
    const api = createTraccarApi(http);
    expect(await api.getDevice(4)).toEqual({ id: 4, name: "A", uniqueId: "jh-1" });
    expect(await api.getDevice(5)).toBeNull();
    expect(calls[0]).toEqual({ method: "get", url: "/api/devices", params: { id: 4 }, headers: undefined });
  });

  test("createDevice posts name, uniqueId and groupId", async () => {
    const { http, calls } = fakeHttp([{ id: 9, name: "Hunter", uniqueId: "jh-1", groupId: 3 }]);
    const created = await createTraccarApi(http).createDevice({ name: "Hunter", uniqueId: "jh-1", groupId: 3 });
    expect(created.id).toBe(9);
    expect(calls[0]).toEqual({ method: "post", url: "/api/devices", body: { name: "Hunter", uniqueId: "jh-1", groupId: 3 } });
  });

  test("updateDevice puts the full object to /api/devices/:id", async () => {
    const device = { id: 9, name: "Hunter", uniqueId: "jh-1", groupId: 5, phone: null, attributes: {} };
    const { http, calls } = fakeHttp([device]);
    await createTraccarApi(http).updateDevice(device);
    expect(calls[0]).toEqual({ method: "put", url: "/api/devices/9", body: device });
  });

  test("getPosition fetches by position id", async () => {
    const { http, calls } = fakeHttp([[{ id: 77, deviceId: 9, speed: 2 }], []]);
    const api = createTraccarApi(http);
    expect(await api.getPosition(77)).toEqual({ id: 77, deviceId: 9, speed: 2 });
    expect(await api.getPosition(78)).toBeNull();
    expect(calls[0].params).toEqual({ id: 77 });
  });

  test("getDistance asks the JSON summary report for the period", async () => {
    const { http, calls } = fakeHttp([[{ deviceId: 9, distance: 1234.5 }], []]);
    const api = createTraccarApi(http);
    const from = new Date("2026-10-16T22:00:00.000Z");
    const to = new Date("2026-10-17T10:00:00.000Z");
    expect(await api.getDistance(9, from, to)).toBe(1234.5);
    expect(await api.getDistance(9, from, to)).toBeNull();
    expect(calls[0]).toEqual({
      method: "get",
      url: "/api/reports/summary",
      params: { deviceId: 9, from: "2026-10-16T22:00:00.000Z", to: "2026-10-17T10:00:00.000Z" },
      headers: { Accept: "application/json" },
    });
  });
});
