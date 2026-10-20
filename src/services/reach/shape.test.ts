import { describe, expect, test } from "bun:test";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import destination from "@turf/destination";
import { coneIn, nearestUnvisited, reachCircle, roundGeometry, simplifyArea, type Group } from "./shape";

const fix: [number, number] = [5.9, 52.0];
const at = (km: number, bearing: number) => destination(fix, km, bearing).geometry.coordinates as [number, number];

describe("reachCircle", () => {
  test("a closed polygon with the radius", () => {
    const circle = reachCircle(fix, 2000);
    const ring = circle.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(Math.abs(area(circle) - Math.PI * 2000 ** 2) / (Math.PI * 2000 ** 2)).toBeLessThan(0.01);
  });
});

describe("simplifyArea", () => {
  test("drops points closer than the tolerance", () => {
    const dense = reachCircle(fix, 500);
    const ring = (simplifyArea(dense) as GeoJSON.Polygon).coordinates[0];
    expect(ring.length).toBeLessThan(dense.coordinates[0].length);
    expect(ring.length).toBeGreaterThan(3);
  });
});

describe("nearestUnvisited", () => {
  const groups: Group[] = [
    { teamApiId: 1, name: "Ver", coord: at(5, 0) },
    { teamApiId: 2, name: "Dichtbij bezocht", coord: at(1, 180) },
    { teamApiId: 3, name: "Dichtbij", coord: at(2, 90) },
  ];

  test("the nearest group not visited, with bearing and distance", () => {
    const target = nearestUnvisited(fix, groups, new Set([2]));
    expect(target?.teamApiId).toBe(3);
    expect(target?.name).toBe("Dichtbij");
    expect(Math.round(target!.bearing)).toBe(90);
    expect(Math.round(target!.distanceM / 10) * 10).toBe(2000);
  });

  test("none left", () => {
    expect(nearestUnvisited(fix, groups, new Set([1, 2, 3]))).toBeNull();
    expect(nearestUnvisited(fix, [], new Set())).toBeNull();
  });
});

describe("coneIn", () => {
  const target = { teamApiId: 3, name: "Dichtbij", bearing: 90, distanceM: 2000 };

  test("the ±30° wedge toward the target, inside the area", () => {
    const circle = reachCircle(fix, 1000);
    const cone = coneIn(fix, target, circle, 1050)!;
    expect(cone).not.toBeNull();
    // About 60/360 of the circle
    expect(area(cone) / area(circle)).toBeGreaterThan(0.14);
    expect(area(cone) / area(circle)).toBeLessThan(0.19);
    expect(booleanPointInPolygon(at(0.5, 90), cone)).toBe(true);
    expect(booleanPointInPolygon(at(0.5, 270), cone)).toBe(false);
  });

  test("no overlap: null", () => {
    const farArea = reachCircle(at(10, 270), 500);
    expect(coneIn(fix, target, farArea, 1000)).toBeNull();
  });
});

describe("roundGeometry", () => {
  test("rounds polygon and multipolygon coordinates to 5 decimals", () => {
    expect(roundGeometry({ type: "Polygon", coordinates: [[[5.123456789, 52.987654321], [5.1, 52.1], [5.2, 52.0], [5.123456789, 52.987654321]]] }))
      .toEqual({ type: "Polygon", coordinates: [[[5.12346, 52.98765], [5.1, 52.1], [5.2, 52.0], [5.12346, 52.98765]]] });
    expect(roundGeometry({ type: "MultiPolygon", coordinates: [[[[1.000004, 2.000006], [1, 3], [2, 2], [1.000004, 2.000006]]]] }).coordinates[0][0][0])
      .toEqual([1, 2.00001]);
  });
});
