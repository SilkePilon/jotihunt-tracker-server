import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { TransitStop } from "../../models/transit-stop.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import { moveM } from "./geo";
import type { Bbox, StopSource } from "./routing";
import { nearestStopDistanceM, refreshTransitStops } from "./transit-stop.service";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("refreshTransitStops", () => {
  test("fetches stops around all groups (+10 km) and replaces the old ones", async () => {
    const far = moveM(O, 5000, 5000);
    await makeTeam(1, "alpha", O);
    await makeTeam(2, "bravo", far);
    await TransitStop.create({ osmId: 1, name: "Oud", kind: "bus", location: { type: "Point", coordinates: O } });
    let requested: Bbox | undefined;
    const source: StopSource = {
      fetchStops: async (bbox) => {
        requested = bbox;
        return [
          { osmId: 10, name: "Station", kind: "train", lng: O[0], lat: O[1] },
          { osmId: 11, name: "Kerk", kind: "bus", lng: 5.49, lat: 52.09 },
        ];
      },
    };
    expect(await refreshTransitStops(source)).toBe(2);
    const [west, south, east, north] = requested!;
    expect(west).toBeLessThan(moveM(O, -9000, 0)[0]);
    expect(south).toBeLessThan(moveM(O, 0, -9000)[1]);
    expect(east).toBeGreaterThan(moveM(far, 9000, 0)[0]);
    expect(north).toBeGreaterThan(moveM(far, 0, 9000)[1]);
    expect((await TransitStop.find().lean()).map((stop) => stop.name).sort()).toEqual(["Kerk", "Station"]);
  });

  test("an empty result keeps the existing stops", async () => {
    await makeTeam(1, "alpha", O);
    await TransitStop.create({ osmId: 1, name: "Oud", kind: "bus", location: { type: "Point", coordinates: O } });
    expect(await refreshTransitStops({ fetchStops: async () => [] })).toBe(0);
    expect(await TransitStop.countDocuments()).toBe(1);
  });

  test("does nothing without groups", async () => {
    const fetchStops = mock(async () => []);
    expect(await refreshTransitStops({ fetchStops })).toBe(0);
    expect(fetchStops).not.toHaveBeenCalled();
  });
});

describe("nearestStopDistanceM", () => {
  test("distance to the nearest stop, Infinity without stops", async () => {
    expect(await nearestStopDistanceM(O)).toBe(Infinity);
    await TransitStop.create({ osmId: 1, name: "Dichtbij", kind: "bus", location: { type: "Point", coordinates: moveM(O, 200, 0) } });
    await TransitStop.create({ osmId: 2, name: "Ver", kind: "train", location: { type: "Point", coordinates: moveM(O, 3000, 0) } });
    expect(await nearestStopDistanceM(O)).toBeCloseTo(200, -1);
  });
});
