import { describe, expect, test } from "bun:test";
import { RoutingUnavailableError } from "../prediction/routing";
import { buildNightCustomModel, createGraphHopperRouter, type GetFn, type NightArea } from "./graphhopper.client";

const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[5.8, 52], [5.81, 52], [5.81, 52.01], [5.8, 52.01], [5.8, 52]]] };
const areas: NightArea[] = [
  { id: "a1", name: "Open park", kind: "open", polygon: square },
  { id: "a2", name: "Dicht bos", kind: "closed", polygon: square },
];

describe("buildNightCustomModel", () => {
  test("open areas first, then the night block, then closed areas", () => {
    const model = buildNightCustomModel(areas) as { priority: Record<string, string>[]; areas: { features: { id: string }[] } };
    expect(model.priority).toEqual([
      { if: "in_open_0", multiply_by: "1" },
      { else_if: "foot_temporal_access == NO", multiply_by: "0" },
      { if: "in_closed_0 && (road_class == PATH || road_class == FOOTWAY || road_class == TRACK || road_class == BRIDLEWAY)", multiply_by: "0" },
    ]);
    expect(model.areas.features.map((f) => f.id)).toEqual(["open_0", "closed_0"]);
  });

  test("no areas: only the night block", () => {
    expect(buildNightCustomModel([])).toEqual({ priority: [{ if: "foot_temporal_access == NO", multiply_by: "0" }] });
  });
});

describe("createGraphHopperRouter", () => {
  const ok = { status: 200, json: { paths: [{ distance: 1234.5, time: 600000, points: { coordinates: [[5.8, 52], [5.81, 52.01]] } }] } };

  test("maps the response and sends the night model only at night", async () => {
    const calls: unknown[] = [];
    const router = createGraphHopperRouter("http://gh:8989", { post: async (_u, body) => (calls.push(body), ok) });
    const day = await router.route({ profile: "foot", from: [5.8, 52], to: [5.81, 52.01], night: false, nightAreas: areas });
    expect(day).toEqual({ coordinates: [[5.8, 52], [5.81, 52.01]], distanceM: 1234.5, durationS: 600 });
    expect((calls[0] as Record<string, unknown>).custom_model).toBeUndefined();
    await router.route({ profile: "foot", from: [5.8, 52], to: [5.81, 52.01], night: true, nightAreas: [] });
    expect((calls[1] as Record<string, unknown>).custom_model).toEqual({ priority: [{ if: "foot_temporal_access == NO", multiply_by: "0" }] });
  });

  test("car never gets the night model", async () => {
    const calls: unknown[] = [];
    const router = createGraphHopperRouter("http://gh:8989", { post: async (_u, body) => (calls.push(body), ok) });
    await router.route({ profile: "car", from: [5.8, 52], to: [5.81, 52.01], night: true, nightAreas: areas });
    expect((calls[0] as Record<string, unknown>).custom_model).toBeUndefined();
  });

  test("errors become RoutingUnavailableError", async () => {
    const notFound = createGraphHopperRouter("http://gh:8989", { post: async () => ({ status: 400, json: { message: "Cannot find point" } }) });
    await expect(notFound.route({ profile: "foot", from: [0, 0], to: [1, 1], night: false, nightAreas: [] })).rejects.toMatchObject({ kind: "request" });
    const down = createGraphHopperRouter("http://gh:8989", { post: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(down.route({ profile: "foot", from: [0, 0], to: [1, 1], night: false, nightAreas: [] })).rejects.toBeInstanceOf(RoutingUnavailableError);
    const unset = createGraphHopperRouter(undefined);
    await expect(unset.route({ profile: "foot", from: [0, 0], to: [1, 1], night: false, nightAreas: [] })).rejects.toMatchObject({ kind: "permanent" });
  });

  test("busy answers (408/429) and 200 without points are temporary", async () => {
    const req = { profile: "foot" as const, from: [0, 0] as [number, number], to: [1, 1] as [number, number], night: false, nightAreas: [] };
    for (const status of [408, 429]) {
      const busy = createGraphHopperRouter("http://gh:8989", { post: async () => ({ status, json: { message: "busy" } }) });
      await expect(busy.route(req)).rejects.toMatchObject({ kind: "temporary" });
    }
    const noPoints = createGraphHopperRouter("http://gh:8989", { post: async () => ({ status: 200, json: { paths: [{ distance: 1, time: 1000 }] } }) });
    await expect(noPoints.route(req)).rejects.toMatchObject({ kind: "temporary" });
  });
});

describe("isochrone", () => {
  const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[5.8, 52], [5.81, 52], [5.81, 52.01], [5.8, 52]]] };

  test("asks for one bucket by distance and returns the polygon", async () => {
    const urls: string[] = [];
    const router = createGraphHopperRouter("http://gh:8989/", { get: async (url) => (urls.push(url), { status: 200, json: { polygons: [{ type: "Feature", geometry: square, properties: {} }] } }) });
    expect(await router.isochrone({ profile: "foot_night", point: [5.85, 52.05], distanceM: 3456.7 })).toEqual(square);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/isochrone");
    expect(Object.fromEntries(url.searchParams)).toEqual({ point: "52.05,5.85", profile: "foot_night", distance_limit: "3457", buckets: "1" });
  });

  test("no URL is permanent", async () => {
    const error = await createGraphHopperRouter(undefined).isochrone({ profile: "foot", point: [5.8, 52], distanceM: 100 }).catch((e) => e);
    expect(error).toBeInstanceOf(RoutingUnavailableError);
    expect(error.kind).toBe("permanent");
  });

  test("4xx is a request error, 5xx, 429 and a missing polygon are temporary, a throw is temporary", async () => {
    const kindFor = async (get: GetFn) => (await createGraphHopperRouter("http://gh", { get }).isochrone({ profile: "foot", point: [5.8, 52], distanceM: 100 }).catch((e) => e)).kind;
    expect(await kindFor(async () => ({ status: 400, json: { message: "Point not found" } }))).toBe("request");
    expect(await kindFor(async () => ({ status: 500, json: null }))).toBe("temporary");
    expect(await kindFor(async () => ({ status: 429, json: null }))).toBe("temporary");
    expect(await kindFor(async () => ({ status: 200, json: { polygons: [] } }))).toBe("temporary");
    expect(await kindFor(async () => { throw new Error("ECONNREFUSED"); })).toBe("temporary");
  });
});
