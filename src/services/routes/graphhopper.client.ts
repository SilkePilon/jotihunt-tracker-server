import { RoutingUnavailableError } from "../prediction/routing";

export type NightAreaKind = "closed" | "open";
export interface NightArea { id: string; name: string; kind: NightAreaKind; polygon: GeoJSON.Polygon }
export interface RouteRequest { profile: "foot" | "car"; from: [number, number]; to: [number, number]; night: boolean; nightAreas: NightArea[] }
export interface RouteResult { coordinates: [number, number][]; distanceM: number; durationS: number }
export interface Router { route(request: RouteRequest): Promise<RouteResult> }
export type PostFn = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: unknown }>;
export type ReachProfile = "foot" | "foot_night";
/** `point` is [lng, lat] */
export interface IsochroneRequest { profile: ReachProfile; point: [number, number]; distanceM: number }
export interface IsochroneRouter { isochrone(request: IsochroneRequest): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon> }
export type GetFn = (url: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

const UNPAVED = "(road_class == PATH || road_class == FOOTWAY || road_class == TRACK || road_class == BRIDLEWAY)";
const NIGHT_BLOCK = "foot_temporal_access == NO";

/**
 * Custom model for a night walking request: "open" admin areas skip the night block, OSM night-closed ways
 * (rewritten by the router's prepare step) get priority 0, unpaved ways in "closed" admin areas too. Roads stay open.
 */
export function buildNightCustomModel(areas: NightArea[]): object {
  const open = areas.filter((a) => a.kind === "open");
  const closed = areas.filter((a) => a.kind === "closed");
  const features = [
    ...open.map((a, i) => ({ type: "Feature", id: `open_${i}`, properties: {}, geometry: a.polygon })),
    ...closed.map((a, i) => ({ type: "Feature", id: `closed_${i}`, properties: {}, geometry: a.polygon })),
  ];
  const priority: Record<string, string>[] = [];
  if (open.length) {
    priority.push({ if: open.map((_, i) => `in_open_${i}`).join(" || "), multiply_by: "1" });
    priority.push({ else_if: NIGHT_BLOCK, multiply_by: "0" });
  } else {
    priority.push({ if: NIGHT_BLOCK, multiply_by: "0" });
  }
  closed.forEach((_, i) => priority.push({ if: `in_closed_${i} && ${UNPAVED}`, multiply_by: "0" }));
  return features.length ? { priority, areas: { type: "FeatureCollection", features } } : { priority };
}

const defaultPost: PostFn = async (url, body, timeoutMs) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const defaultGet: GetFn = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

interface GhIsochrone { polygons?: { geometry?: { type?: string } }[]; message?: string }

/** 408/429 are the router being busy, not a bad request */
const isRequestError = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

interface GhResponse { paths?: { distance: number; time: number; points: { coordinates: [number, number][] } }[]; message?: string }

export function createGraphHopperRouter(baseUrl: string | undefined, deps: { post?: PostFn; get?: GetFn; timeoutMs?: number } = {}): Router & IsochroneRouter {
  const post = deps.post ?? defaultPost;
  const get = deps.get ?? defaultGet;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return {
    async route({ profile, from, to, night, nightAreas }) {
      if (!baseUrl) throw new RoutingUnavailableError("ROUTER_URL is not set", { kind: "permanent" });
      const body: Record<string, unknown> = { profile, points: [from, to], points_encoded: false, instructions: false, calc_points: true };
      if (profile === "foot" && night) body.custom_model = buildNightCustomModel(nightAreas);
      let res: { status: number; json: unknown };
      try {
        res = await post(`${baseUrl.replace(/\/$/, "")}/route`, body, timeoutMs);
      } catch (error) {
        throw new RoutingUnavailableError(`Router unreachable: ${error instanceof Error ? error.message : String(error)}`, { kind: "temporary" });
      }
      const json = (res.json ?? {}) as GhResponse;
      if (isRequestError(res.status)) throw new RoutingUnavailableError(json.message ?? `Router answered ${res.status}`, { kind: "request" });
      const path = json.paths?.[0];
      if (res.status !== 200 || !path) throw new RoutingUnavailableError(json.message ?? `Router answered ${res.status}`, { kind: "temporary" });
      if (!Array.isArray(path.points?.coordinates)) throw new RoutingUnavailableError("Router answered without route points", { kind: "temporary" });
      return { coordinates: path.points.coordinates, distanceM: path.distance, durationS: Math.round(path.time / 1000) };
    },
    /** The area reachable within `distanceM` along the profile's ways (one bucket). */
    async isochrone({ profile, point, distanceM }) {
      if (!baseUrl) throw new RoutingUnavailableError("ROUTER_URL is not set", { kind: "permanent" });
      const query = new URLSearchParams({ point: `${point[1]},${point[0]}`, profile, distance_limit: String(Math.round(distanceM)), buckets: "1" });
      let res: { status: number; json: unknown };
      try {
        res = await get(`${baseUrl.replace(/\/$/, "")}/isochrone?${query}`, timeoutMs);
      } catch (error) {
        throw new RoutingUnavailableError(`Router unreachable: ${error instanceof Error ? error.message : String(error)}`, { kind: "temporary" });
      }
      const json = (res.json ?? {}) as GhIsochrone;
      if (isRequestError(res.status)) throw new RoutingUnavailableError(json.message ?? `Router answered ${res.status}`, { kind: "request" });
      const geometry = json.polygons?.[0]?.geometry;
      if (res.status !== 200 || !geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
        throw new RoutingUnavailableError(json.message ?? `Router answered ${res.status} without a polygon`, { kind: "temporary" });
      }
      return geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    },
  };
}
