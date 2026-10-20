import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import destination from "@turf/destination";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { logger } from "../../logger";
import { Area } from "../../models/area.model";
import { Marker, MarkerType } from "../../models/marker.model";
import { Team } from "../../models/team.model";
import { RoutingUnavailableError } from "../prediction/routing";
import type { IsochroneRequest, IsochroneRouter } from "../routes/graphhopper.client";
import type { TrailsResponse } from "../routes/trails.service";
import { createReachService } from "./reach.service";
import { coneIn, reachCircle } from "./shape";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

// 14:00 on 17 Oct is daytime in Gelderland
const t = (hhmm: string) => new Date(`2026-10-17T${hhmm}:00+02:00`);
const start: [number, number] = [5.9, 52.0];
const east = (km: number) => destination(start, km, 90).geometry.coordinates as [number, number];
const point = (c: [number, number]) => ({ type: "Point" as const, coordinates: c });
// Covers the fixes and the groups east of them, so the cone has something to cut
const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[5.8, 51.9], [6.2, 51.9], [6.2, 52.1], [5.8, 52.1], [5.8, 51.9]]] };
const noTrails = async (): Promise<TrailsResponse> => ({ enabled: false, trails: { type: "FeatureCollection", features: [] } });

function fakeRouter(answer: () => Promise<GeoJSON.Polygon>) {
  const calls: IsochroneRequest[] = [];
  const router: IsochroneRouter = { async isochrone(request) { calls.push(request); return answer(); } };
  return { router, calls };
}

async function team(apiId: number, name: string, area: string, coord: [number, number]) {
  await Team.create({ apiId, name, accomodation: "x", street: "x", houseNumber: 1, postCode: "1234AB", city: "x", area, location: point(coord) });
}

describe("reach service", () => {
  test("isochrone at the measured speed, cone toward the nearest unvisited group", async () => {
    await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }]);
    // Two legs of 1 h at 4 km/h straight × 1.2 → 4 km/h
    await Marker.create([
      { area: "alpha", time: t("11:00"), location: point(start), type: MarkerType.Hint },
      { area: "alpha", time: t("12:00"), location: point(east(4 / 1.2)), type: MarkerType.Hint },
      { area: "alpha", time: t("13:00"), location: point(east(8 / 1.2)), type: MarkerType.Hunt },
    ]);
    await team(1, "Bezocht", "Alpha", east(7));
    await team(2, "Open", "Alpha", east(9));
    const { router, calls } = fakeRouter(async () => square);
    const service = createReachService({
      router, trails: noTrails, now: () => t("13:30"), configured: () => true,
      visits: async () => [{ area: "alpha", teamApiId: 1, round: 1, state: "visited", source: "auto", visitedAt: null }],
    });
    const { areas } = await service.reach();
    expect(areas).toHaveLength(1);
    const [alpha] = areas;
    expect(alpha).toMatchObject({ area: "alpha", speedKmh: 4, measured: true, legs: 2, distanceM: 2000, capped: false, night: false, estimate: false });
    expect(alpha.fix).toMatchObject({ type: "hunt", at: t("13:00").toISOString() });
    expect(calls).toEqual([{ profile: "foot", point: east(8 / 1.2), distanceM: 2000 }]);
    expect(alpha.cone?.teamApiId).toBe(2);
    expect(alpha.cone?.polygon).toBeTruthy();
  });

  test("router down: circle, estimate; OV areas and areas without markers are skipped", async () => {
    await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }, { name: "Bravo", status: "blue", updatedAt: t("09:00") }]);
    await Marker.create([
      { area: "alpha", time: t("13:00"), location: point(start), type: MarkerType.Hint },
      { area: "bravo", time: t("13:00"), location: point(start), type: MarkerType.Hint },
    ]);
    const { router } = fakeRouter(async () => { throw new RoutingUnavailableError("down", { kind: "temporary" }); });
    const service = createReachService({ router, trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [] });
    const { areas } = await service.reach();
    expect(areas.map((a) => a.area)).toEqual(["alpha"]);
    expect(areas[0]).toMatchObject({ speedKmh: 5, measured: false, distanceM: 5000, estimate: true, cone: null });
    expect(areas[0].polygon.type).toBe("Polygon");
  });

  test("capped at 3 hours of walking, night profile after sunset", async () => {
    await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }]);
    await Marker.create([{ area: "alpha", time: t("16:00"), location: point(start), type: MarkerType.Hint }]);
    const { router, calls } = fakeRouter(async () => square);
    const service = createReachService({ router, trails: noTrails, now: () => t("22:00"), configured: () => true, visits: async () => [] });
    const [alpha] = (await service.reach()).areas;
    expect(alpha).toMatchObject({ capped: true, night: true, distanceM: 15000 });
    expect(calls[0].profile).toBe("foot_night");
  });

  test("same fix and distance within the memo: one router call", async () => {
    await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }]);
    await Marker.create([{ area: "alpha", time: t("13:00"), location: point(start), type: MarkerType.Hint }]);
    const { router, calls } = fakeRouter(async () => square);
    const service = createReachService({ router, trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [] });
    await service.reach();
    await service.reachJson();
    expect(calls).toHaveLength(1);
  });

  describe("spots between hints", () => {
    async function setup(secondMode: "walk" | "car") {
      await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }]);
      // Hint → spot → hint → spot → hint; the spots sit off the line, the fix stays the newest hint
      const [h1, s1, h2, s2, h3] = await Marker.create([
        { area: "alpha", time: t("10:00"), location: point(start), type: MarkerType.Hint },
        { area: "alpha", time: t("10:30"), location: point(east(30)), type: MarkerType.Spot },
        { area: "alpha", time: t("11:00"), location: point(east(1)), type: MarkerType.Hint },
        { area: "alpha", time: t("11:30"), location: point(east(30)), type: MarkerType.Spot },
        { area: "alpha", time: t("12:00"), location: point(east(2)), type: MarkerType.Hint },
      ]);
      const id = (a: { _id: unknown }, b: { _id: unknown }) => `${String(a._id)}:${String(b._id)}`;
      const feature = (fid: string, mode: "walk" | "car", distanceM: number) => ({
        type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [start, east(1)] },
        properties: { id: fid, mode, distanceM },
      });
      // Leg 1: 2 + 2.6 km in 1 h; leg 2: 2 + 2 km in 1 h (or a car piece)
      const trails = async () => ({
        enabled: true,
        trails: { type: "FeatureCollection", features: [
          feature(id(h1, s1), "walk", 2000), feature(id(s1, h2), "walk", 2600),
          feature(id(h2, s2), "walk", 2000), feature(id(s2, h3), secondMode, 2000),
        ] },
      }) as unknown as TrailsResponse;
      const { router } = fakeRouter(async () => square);
      return { service: createReachService({ router, trails, now: () => t("12:30"), configured: () => true, visits: async () => [] }), h3 };
    }

    test("routed pieces are summed into one walking leg", async () => {
      const { service, h3 } = await setup("walk");
      const [alpha] = (await service.reach()).areas;
      // Median of 4.6 and 4 km/h
      expect(alpha).toMatchObject({ speedKmh: 4.3, measured: true, legs: 2 });
      expect(alpha.fix).toMatchObject({ id: String(h3._id), type: "hint" });
    });

    test("a car piece skips the whole leg", async () => {
      const { service } = await setup("car");
      const [alpha] = (await service.reach()).areas;
      expect(alpha).toMatchObject({ speedKmh: 5, measured: false, legs: 1 });
    });
  });

  describe("per-area failures", () => {
    // Two points: simplify throws "invalid polygon" on it
    const degenerate = { type: "Polygon", coordinates: [[[5.9, 52.0], [5.91, 52.0]]] } as unknown as GeoJSON.Polygon;
    const bravoAt = east(20);

    async function twoAreas() {
      await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }, { name: "Bravo", status: "green", updatedAt: t("09:00") }]);
      await Marker.create([
        { area: "alpha", time: t("13:00"), location: point(start), type: MarkerType.Hint },
        { area: "bravo", time: t("13:00"), location: point(bravoAt), type: MarkerType.Hint },
      ]);
      await team(1, "A", "Alpha", east(1));
      await team(2, "B", "Bravo", east(21));
    }
    const routerByPoint = (alpha: GeoJSON.Polygon) => {
      const router: IsochroneRouter = { async isochrone({ point: p }) { return p[0] === start[0] ? alpha : square; } };
      return router;
    };

    test("a degenerate isochrone falls back to a circle for that area only, logged once", async () => {
      await twoAreas();
      let clock = t("14:00");
      const warn = spyOn(logger, "warn");
      try {
        const service = createReachService({ router: routerByPoint(degenerate), trails: noTrails, now: () => clock, configured: () => true, visits: async () => [] });
        const { areas } = await service.reach();
        expect(areas.map((a) => [a.area, a.estimate])).toEqual([["alpha", true], ["bravo", false]]);
        expect(areas[0].polygon.type).toBe("Polygon");
        expect(areas[0].cone).not.toBeNull();
        clock = t("14:05"); // past the memo: computes again
        await service.reach();
        expect(warn.mock.calls.filter(([m]) => String(m).includes("alpha")).length).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });

    test("a failing cone only drops that cone", async () => {
      await twoAreas();
      const service = createReachService({
        router: routerByPoint(square), trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [],
        shapes: { coneIn: (fix, target, area, radius) => { if (fix[0] === start[0]) throw new Error("boom"); return coneIn(fix, target, area, radius); } },
      });
      const { areas } = await service.reach();
      expect(areas.map((a) => [a.area, a.cone === null])).toEqual([["alpha", true], ["bravo", false]]);
    });

    test("any other per-area error skips just that area", async () => {
      await twoAreas();
      const { router } = fakeRouter(async () => { throw new RoutingUnavailableError("down", { kind: "temporary" }); });
      const service = createReachService({
        router, trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [],
        shapes: { reachCircle: (center, distanceM) => { if (center[0] === start[0]) throw new Error("boom"); return reachCircle(center, distanceM); } },
      });
      const { areas } = await service.reach();
      expect(areas.map((a) => a.area)).toEqual(["bravo"]);
    });

    test("a rejected compute does not poison the next call", async () => {
      await twoAreas();
      let fail = true;
      const service = createReachService({
        router: routerByPoint(square), trails: noTrails, now: () => t("14:00"), configured: () => true,
        visits: async () => { if (fail) throw new Error("db down"); return []; },
      });
      await expect(service.reach()).rejects.toThrow("db down");
      fail = false;
      expect((await service.reach()).areas).toHaveLength(2);
    });
  });

  test("isochrones run at most 3 at a time, results stay in area order", async () => {
    const names = ["echo", "delta", "charlie", "bravo", "alpha"];
    await Area.create(names.map((name) => ({ name, status: "green", updatedAt: t("09:00") })));
    await Marker.create(names.map((area, i) => ({ area, time: t("13:00"), location: point(east(i * 5)), type: MarkerType.Hint })));
    let running = 0;
    let peak = 0;
    const router: IsochroneRouter = {
      async isochrone() {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return square;
      },
    };
    const service = createReachService({ router, trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [] });
    const { areas } = await service.reach();
    expect(areas.map((a) => a.area)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    expect(peak).toBe(3);
  });

  test("output coordinates have at most 5 decimals", async () => {
    await Area.create([{ name: "Alpha", status: "green", updatedAt: t("09:00") }]);
    await Marker.create([{ area: "alpha", time: t("13:00"), location: point(start), type: MarkerType.Hint }]);
    await team(1, "A", "Alpha", east(1));
    const { router } = fakeRouter(async () => { throw new RoutingUnavailableError("down", { kind: "temporary" }); });
    const service = createReachService({ router, trails: noTrails, now: () => t("14:00"), configured: () => true, visits: async () => [] });
    const [alpha] = (await service.reach()).areas;
    const decimals = (g: unknown) => Math.max(...(JSON.stringify(g).match(/\d+\.\d+/g) ?? []).map((n) => n.split(".")[1].length));
    expect(decimals(alpha.polygon)).toBeLessThanOrEqual(5);
    expect(decimals(alpha.cone?.polygon)).toBeLessThanOrEqual(5);
  });
});
