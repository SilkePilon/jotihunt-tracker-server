import { fromGeojsonVt } from "@maplibre/vt-pbf";
import GeoJSONVT from "geojson-vt";
import type { Feature, MultiPolygon, Polygon } from "geojson";

/** The 3D building tiles exist at this zoom only; MapLibre overzooms them for closer zooms. */
export const TILE_ZOOM = 15;
/** Layer name inside each vector tile */
export const TILE_LAYER = "buildings";
export const MAX_RADIUS_KM = 25;

export interface TileXY {
  x: number;
  y: number;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The Netherlands (PDOK landgebied border, rounded outwards): no 3DBAG data outside it. */
export const NL_BOUNDS: Bounds = { west: 3.3, south: 50.75, east: 7.23, north: 53.58 };

const TILES = 2 ** TILE_ZOOM;
/** Vector tile coordinate extent (geojson-vt and MVT default) */
const TILE_EXTENT = 4096;
const KM_PER_DEGREE = 111.32;

const lonOf = (x: number) => (x / TILES) * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILES))) * 180) / Math.PI;

export function tileBounds({ x, y }: TileXY): Bounds {
  return { west: lonOf(x), east: lonOf(x + 1), north: latOf(y), south: latOf(y + 1) };
}

export function tileOf(lon: number, lat: number): TileXY {
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * TILES),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * TILES),
  };
}

export const tileId = ({ x, y }: TileXY) => `${TILE_ZOOM}/${x}/${y}`;

export function parseTileId(id: string): TileXY {
  const [, x, y] = id.split("/").map(Number);
  return { x, y };
}

export function isValidTile({ x, y }: TileXY): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < TILES && y < TILES;
}

export function inNetherlands(tile: TileXY): boolean {
  const b = tileBounds(tile);
  return b.east > NL_BOUNDS.west && b.west < NL_BOUNDS.east && b.north > NL_BOUNDS.south && b.south < NL_BOUNDS.north;
}

/** Every NL tile that touches the square around the circle (lat, lon, radiusKm). */
export function tilesAround(lat: number, lon: number, radiusKm: number): TileXY[] {
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLon = radiusKm / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const northWest = tileOf(lon - dLon, lat + dLat);
  const southEast = tileOf(lon + dLon, lat - dLat);
  const tiles: TileXY[] = [];
  for (let x = northWest.x; x <= southEast.x; x++) {
    for (let y = northWest.y; y <= southEast.y; y++) {
      if (inNetherlands({ x, y })) tiles.push({ x, y });
    }
  }
  return tiles;
}

/** One 3DBAG lod22 roof part as the WFS returns it (only the properties we ask for). */
export interface RawBuildingPart {
  geometry: Polygon | MultiPolygon | null;
  properties: { b3_h_70p?: number | null; b3_h_maaiveld?: number | null } | null;
}

/** Height above the ground in metres (one decimal); null when unknown or not above the ground. */
export function buildingHeight(properties: RawBuildingPart["properties"]): number | null {
  const roof = properties?.b3_h_70p;
  const ground = properties?.b3_h_maaiveld;
  if (typeof roof !== "number" || typeof ground !== "number") return null;
  const height = Math.round((roof - ground) * 10) / 10;
  return height > 0 ? height : null;
}

export type BuildingFeature = Feature<Polygon | MultiPolygon, { h: number }>;

export function toBuildingFeatures(parts: RawBuildingPart[]): BuildingFeature[] {
  const features: BuildingFeature[] = [];
  for (const part of parts) {
    const h = buildingHeight(part.properties);
    if (h === null || !part.geometry) continue;
    features.push({ type: "Feature", geometry: part.geometry, properties: { h } });
  }
  return features;
}

/** The vector tile (layer "buildings") of `tile`; null when no feature lands in it. */
export function encodeTile({ x, y }: TileXY, features: BuildingFeature[]): Uint8Array | null {
  if (!features.length) return null;
  const index = new GeoJSONVT({ type: "FeatureCollection", features }, { maxZoom: TILE_ZOOM, indexMaxZoom: TILE_ZOOM, extent: TILE_EXTENT, buffer: 64 });
  const tile = index.getTile(TILE_ZOOM, x, y);
  if (!tile || !tile.features.length) return null;
  return fromGeojsonVt({ [TILE_LAYER]: tile }, { version: 2, extent: TILE_EXTENT });
}
