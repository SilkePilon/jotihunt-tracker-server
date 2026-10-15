import { describe, expect, test } from "bun:test";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import {
  buildingHeight,
  encodeTile,
  inNetherlands,
  isValidTile,
  MAX_RADIUS_KM,
  parseTileId,
  tileBounds,
  tileId,
  tileOf,
  tilesAround,
  toBuildingFeatures,
  type RawBuildingPart,
} from "./buildings.helpers";

// Arnhem Stikkerstraat area
const LON = 5.9005;
const LAT = 51.9805;

const square = (lon: number, lat: number, size = 0.0005): RawBuildingPart["geometry"] => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});

describe("tiles", () => {
  test("tileOf finds the z15 tile and tileBounds contains the point", () => {
    const tile = tileOf(LON, LAT);
    expect(tile).toEqual({ x: 16921, y: 10826 });
    const b = tileBounds(tile);
    expect(b.west).toBeLessThanOrEqual(LON);
    expect(b.east).toBeGreaterThan(LON);
    expect(b.south).toBeLessThanOrEqual(LAT);
    expect(b.north).toBeGreaterThan(LAT);
    // ~0.75 km wide at this latitude
    expect((b.east - b.west) * 111.32 * Math.cos((LAT * Math.PI) / 180)).toBeCloseTo(0.75, 1);
  });

  test("tileId and parseTileId round-trip", () => {
    expect(tileId({ x: 16921, y: 10826 })).toBe("15/16921/10826");
    expect(parseTileId("15/16921/10826")).toEqual({ x: 16921, y: 10826 });
  });

  test("isValidTile rejects out-of-range and non-integer tiles", () => {
    expect(isValidTile({ x: 0, y: 0 })).toBe(true);
    expect(isValidTile({ x: 32767, y: 32767 })).toBe(true);
    expect(isValidTile({ x: 32768, y: 0 })).toBe(false);
    expect(isValidTile({ x: -1, y: 0 })).toBe(false);
    expect(isValidTile({ x: 1.5, y: 0 })).toBe(false);
    expect(isValidTile({ x: Number.NaN, y: 0 })).toBe(false);
  });

  test("inNetherlands", () => {
    expect(inNetherlands(tileOf(LON, LAT))).toBe(true);
    // Paris
    expect(inNetherlands(tileOf(2.35, 48.85))).toBe(false);
  });

  test("tilesAround covers the radius square and stays in NL", () => {
    const tiles = tilesAround(LAT, LON, 5);
    // 10 km square of ~0.75 km tiles: about 14 × 14
    expect(tiles.length).toBeGreaterThan(150);
    expect(tiles.length).toBeLessThan(300);
    expect(tiles).toContainEqual(tileOf(LON, LAT));
    expect(tiles.every(inNetherlands)).toBe(true);
    expect(MAX_RADIUS_KM).toBe(25);
  });
});

describe("heights", () => {
  test("roof minus ground, one decimal", () => {
    expect(buildingHeight({ b3_h_70p: 18.76, b3_h_maaiveld: 9.2 })).toBe(9.6);
  });

  test("missing or non-positive heights are skipped", () => {
    expect(buildingHeight({ b3_h_70p: null, b3_h_maaiveld: 9 })).toBeNull();
    expect(buildingHeight({ b3_h_70p: 10 })).toBeNull();
    expect(buildingHeight({ b3_h_70p: 9, b3_h_maaiveld: 9 })).toBeNull();
    expect(buildingHeight({ b3_h_70p: 8, b3_h_maaiveld: 9 })).toBeNull();
    expect(buildingHeight(null)).toBeNull();
  });

  test("toBuildingFeatures keeps parts with a geometry and a height", () => {
    const features = toBuildingFeatures([
      { geometry: square(LON, LAT), properties: { b3_h_70p: 20, b3_h_maaiveld: 10 } },
      { geometry: null, properties: { b3_h_70p: 20, b3_h_maaiveld: 10 } },
      { geometry: square(LON, LAT), properties: { b3_h_70p: null, b3_h_maaiveld: 10 } },
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].properties).toEqual({ h: 10 });
    expect(features[0].geometry.type).toBe("Polygon");
  });
});

describe("encodeTile", () => {
  test("encodes the features as layer 'buildings' with property h", () => {
    const tile = tileOf(LON, LAT);
    const features = toBuildingFeatures([{ geometry: square(LON, LAT), properties: { b3_h_70p: 22.3, b3_h_maaiveld: 10 } }]);
    const mvt = encodeTile(tile, features);
    expect(mvt).not.toBeNull();
    const decoded = new VectorTile(new PbfReader(mvt!));
    expect(decoded.layers.buildings.length).toBe(1);
    expect(decoded.layers.buildings.feature(0).properties.h).toBe(12.3);
  });

  test("no features: null", () => {
    expect(encodeTile(tileOf(LON, LAT), [])).toBeNull();
  });

  test("features outside the tile only: null", () => {
    const features = toBuildingFeatures([{ geometry: square(LON + 0.1, LAT), properties: { b3_h_70p: 20, b3_h_maaiveld: 10 } }]);
    expect(encodeTile(tileOf(LON, LAT), features)).toBeNull();
  });
});
