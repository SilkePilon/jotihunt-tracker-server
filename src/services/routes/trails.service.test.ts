import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { Marker, MarkerType } from "../../models/marker.model";
import { AreaStatusEvent } from "../../models/area-status-event.model";
import { RouteLeg } from "../../models/route-leg.model";
import { RoutingUnavailableError } from "../prediction/routing";
import type { RouteRequest, Router } from "./graphhopper.client";
import { createTrailsService } from "./trails.service";
import { resetNightAreas } from "../../settings/night-areas-setting";

beforeAll(connectTestDb);
beforeEach(async () => { await clearTestDb(); resetNightAreas(); });
afterAll(disconnectTestDb);

const t = (hhmm: string) => new Date(`2026-10-17T${hhmm}:00+02:00`);
const point = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] });

function fakeRouter(walkMinutes: number) {
  const calls: RouteRequest[] = [];
  const router: Router = {
    async route(request) {
      calls.push(request);
      const minutes = request.profile === "car" ? 20 : walkMinutes;
      return { coordinates: [request.from, [(request.from[0] + request.to[0]) / 2, request.from[1]], request.to], distanceM: 5000, durationS: minutes * 60 };
    },
  };
  return { router, calls };
}

describe("trails service", () => {
  test("routes walking legs, caches them and classifies a car leg", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.92, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:20"), location: point(6.1, 52.1), type: MarkerType.Hunt },
    ]);
    const { router, calls } = fakeRouter(40);
    const service = createTrailsService({ router, now: () => t("12:00") });
    const { enabled, trails } = await service.trails();
    expect(enabled).toBe(true);
    expect(trails.features).toHaveLength(2);
    expect(trails.features[0].properties.mode).toBe("walk");
    expect(trails.features[0].geometry.coordinates).toHaveLength(3);
    // 40 min walking in 20 min elapsed → too fast → car route
    expect(trails.features[1].properties).toMatchObject({ mode: "car", reason: "too-fast", fallback: false });
    expect(calls.filter((c) => c.profile === "car")).toHaveLength(1);
    expect(await RouteLeg.countDocuments()).toBe(3);
    service.invalidate();
    await service.trails();
    expect(calls).toHaveLength(3); // all from cache
  });

  test("red status makes the big move", async () => {
    await Marker.create([
      { area: "bravo", time: t("14:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "bravo", time: t("15:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    await AreaStatusEvent.create([{ area: "Bravo", status: "green", at: t("09:00") }, { area: "Bravo", status: "red", at: t("14:10") }, { area: "Bravo", status: "green", at: t("14:40") }]);
    const service = createTrailsService({ router: fakeRouter(30).router, now: () => t("16:00") });
    const { trails } = await service.trails();
    expect(trails.features[0].properties).toMatchObject({ mode: "car", reason: "status-red" });
    expect(trails.features[0].properties.redFrom).toBe(t("14:10").toISOString());
  });

  test("manual legMode on the arrival marker wins", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("10:10"), location: point(5.95, 52.0), type: MarkerType.Hint, legMode: "walk" },
    ]);
    const { trails } = await createTrailsService({ router: fakeRouter(60).router, now: () => t("12:00") }).trails();
    expect(trails.features[0].properties).toMatchObject({ mode: "walk", reason: "manual", manual: true });
  });

  test("router down: straight fallback, nothing cached, cooldown set", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const router: Router = { route: mock(async () => { throw new RoutingUnavailableError("down", { kind: "temporary" }); }) };
    const service = createTrailsService({ router, now: () => t("12:00") });
    const { trails } = await service.trails();
    expect(trails.features[0].properties.fallback).toBe(true);
    expect(trails.features[0].geometry.coordinates).toEqual([[5.9, 52.0], [5.95, 52.0]]);
    expect(await RouteLeg.countDocuments()).toBe(0);
    expect(service.routerCooldownUntil()).toBeGreaterThan(t("12:00").getTime());
  });

  test("no night route: retries by day and flags it", async () => {
    await Marker.create([
      { area: "alpha", time: t("20:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("21:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const router: Router = {
      async route(request) {
        if (request.night) throw new RoutingUnavailableError("Connection between locations not found", { kind: "request" });
        return { coordinates: [request.from, request.to], distanceM: 4000, durationS: 2400 };
      },
    };
    const { trails } = await createTrailsService({ router, now: () => t("22:00") }).trails();
    expect(trails.features[0].properties).toMatchObject({ night: true, nightFallback: true, fallback: false });
  });

  // Extra coverage beyond the brief
  test("night fallback is cached under the night key and reused", async () => {
    await Marker.create([
      { area: "alpha", time: t("20:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("21:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const calls: RouteRequest[] = [];
    const router: Router = {
      async route(request) {
        calls.push(request);
        if (request.night) throw new RoutingUnavailableError("Connection between locations not found", { kind: "request" });
        return { coordinates: [request.from, request.to], distanceM: 4000, durationS: 2400 };
      },
    };
    const service = createTrailsService({ router, now: () => t("22:00") });
    await service.trails();
    expect(calls.map((c) => c.night)).toEqual([true, false]);
    const docs = await RouteLeg.find().lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].nightFallback).toBe(true);
    service.invalidate();
    const { trails } = await service.trails();
    expect(calls).toHaveLength(2);
    expect(trails.features[0].properties).toMatchObject({ night: true, nightFallback: true, fallback: false });
  });

  test("disabled: no routing, empty collection", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const settings = await import("../../settings/night-areas-setting");
    await settings.initNightAreas({ readNightAreas: async () => ({ key: "nightAreas", enabled: false, areas: [] }), writeNightAreas: async () => {} });
    const { router, calls } = fakeRouter(30);
    const result = await createTrailsService({ router, now: () => t("12:00") }).trails();
    expect(result).toEqual({ enabled: false, trails: { type: "FeatureCollection", features: [] } });
    expect(calls).toHaveLength(0);
  });

  test("identical legs are routed once and the new-route budget is shared by walk and car", async () => {
    // Same two points twice (there and back counts separately), plus a far-off car leg
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
      { area: "bravo", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "bravo", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const { router, calls } = fakeRouter(30);
    await createTrailsService({ router, now: () => t("12:00") }).trails();
    expect(calls).toHaveLength(1);

    await clearTestDb();
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.92, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:20"), location: point(6.1, 52.1), type: MarkerType.Hunt },
    ]);
    const second = fakeRouter(40);
    const { trails } = await createTrailsService({ router: second.router, now: () => t("12:00"), maxNewRoutesPerCall: 2 }).trails();
    expect(second.calls).toHaveLength(2); // both walks; the car route waits for the next call
    expect(trails.features[1].properties).toMatchObject({ mode: "car", fallback: true });
  });

  test("invalidate during a computation does not memoize the stale result", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const router: Router = {
      async route(request) {
        if (first) { first = false; await gate; }
        return { coordinates: [request.from, request.to], distanceM: 1, durationS: 60 };
      },
    };
    const service = createTrailsService({ router, now: () => t("12:00") });
    const pending = service.trails();
    await new Promise((r) => setTimeout(r, 50));
    await Marker.create({ area: "alpha", time: t("11:30"), location: point(5.97, 52.0), type: MarkerType.Hint });
    service.invalidate();
    release();
    await pending;
    const { trails } = await service.trails();
    expect(trails.features).toHaveLength(2);
  });
  test("an unroutable leg does not starve the others and is not retried within the TTL", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("12:00"), location: point(6.0, 52.0), type: MarkerType.Hint },
    ]);
    const calls: RouteRequest[] = [];
    const router: Router = {
      async route(request) {
        calls.push(request);
        if (request.from[0] === 5.9) throw new RoutingUnavailableError("Connection between locations not found", { kind: "request" });
        return { coordinates: [request.from, request.to], distanceM: 1000, durationS: 600 };
      },
    };
    let clock = t("13:00").getTime();
    const service = createTrailsService({ router, now: () => new Date(clock), maxNewRoutesPerCall: 1 });
    const first = await service.trails();
    expect(first.trails.features.map((f) => f.properties.fallback)).toEqual([true, true]);
    expect(calls).toHaveLength(1);
    service.invalidate();
    const second = await service.trails();
    expect(second.trails.features.map((f) => f.properties.fallback)).toEqual([true, false]);
    expect(calls).toHaveLength(2); // the failing leg was not retried
    clock += 11 * 60_000;
    service.invalidate();
    await service.trails();
    expect(calls).toHaveLength(3); // TTL passed: retried
  });

  test("router not configured: trails off, no routing", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const { router, calls } = fakeRouter(30);
    const service = createTrailsService({ router, now: () => t("12:00"), configured: () => false });
    expect(await service.trails()).toEqual({ enabled: false, trails: { type: "FeatureCollection", features: [] } });
    expect(calls).toHaveLength(0);
    expect(service.routerCooldownUntil()).toBe(0);
  });

  test("serialises once per memo and recomputes after a demo switch", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    let dbGen = 1;
    const service = createTrailsService({ router: fakeRouter(30).router, now: () => t("12:00"), dbGeneration: () => dbGen });
    const first = await service.trailsJson();
    expect(await service.trailsJson()).toBe(first); // same string instance, not re-serialised
    expect(JSON.parse(first).trails.features).toHaveLength(1);
    await Marker.create({ area: "alpha", time: t("11:30"), location: point(5.97, 52.0), type: MarkerType.Hint });
    expect(await service.trailsJson()).toBe(first); // still memoized
    dbGen = 2;
    const switched = await service.trailsJson();
    expect(switched).not.toBe(first);
    expect(JSON.parse(switched).trails.features).toHaveLength(2);
  });

  test("resolved routes are reused from memory without querying Mongo", async () => {
    await Marker.create([
      { area: "alpha", time: t("10:00"), location: point(5.9, 52.0), type: MarkerType.Hint },
      { area: "alpha", time: t("11:00"), location: point(5.95, 52.0), type: MarkerType.Hint },
    ]);
    const { router, calls } = fakeRouter(30);
    const service = createTrailsService({ router, now: () => t("12:00") });
    await service.trails();
    await RouteLeg.deleteMany({}); // gone from Mongo: only the in-process copy can serve it
    service.invalidate();
    const { trails } = await service.trails();
    expect(calls).toHaveLength(1);
    expect(trails.features[0].properties.fallback).toBe(false);
  });
});
