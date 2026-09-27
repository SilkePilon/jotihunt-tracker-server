import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, DailyCounter, MinuteBudget, type HttpPost, type Schedule } from "./http";
import { RoutingUnavailableError, type MatrixResult, type RouteResult, type RoutingFailureKind, type WalkingRouter } from "./routing";
import type { LngLat, PolygonGeometry } from "./types";

export const ORS_BASE_URL = "https://api.openrouteservice.org/v2";
/** Free-plan daily quotas per endpoint; beyond these we fall back to estimates. */
export const ORS_DAILY_LIMITS = { matrix: 500, directions: 2000, isochrones: 500 } as const;
/** Free-plan per-minute limits per endpoint; a burst beyond these is queued, not failed. */
export const ORS_MINUTE_LIMITS = { isochrones: 20, matrix: 40, directions: 40 } as const;
type OrsEndpoint = keyof typeof ORS_DAILY_LIMITS;

export interface OrsDeps {
  post?: HttpPost;
  schedule?: Schedule;
  counters?: Record<OrsEndpoint, DailyCounter>;
  budgets?: Record<OrsEndpoint, MinuteBudget>;
}

/** 400/404 (e.g. no routable point) → this request only; 401/403 → permanent; everything else → temporary. */
export function classifyOrsError(error: unknown): RoutingFailureKind {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (status === 400 || status === 404) return "request";
  if (status === 401 || status === 403) return "permanent";
  return "temporary";
}

export function parseOrsMatrix(data: unknown): MatrixResult {
  const { durations, distances } = (data ?? {}) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
  if (!Array.isArray(durations) || !Array.isArray(distances)) throw new RoutingUnavailableError("ORS matrix: unexpected response");
  return { durationsS: durations, distancesM: distances };
}

export function parseOrsRoute(data: unknown): RouteResult {
  const features = (data as { features?: { geometry?: { coordinates?: LngLat[] }; properties?: { summary?: { distance?: number; duration?: number } } }[] })
    ?.features;
  const feature = Array.isArray(features) ? features[0] : undefined;
  const line = feature?.geometry?.coordinates;
  if (!Array.isArray(line) || line.length < 2) throw new RoutingUnavailableError("ORS directions: unexpected response");
  return { line, distanceM: feature?.properties?.summary?.distance ?? 0, durationS: feature?.properties?.summary?.duration ?? 0 };
}

export function parseOrsIsochrones(data: unknown): Record<number, PolygonGeometry> {
  const features = (data as { features?: { geometry?: PolygonGeometry; properties?: { value?: number } }[] })?.features;
  if (!Array.isArray(features)) throw new RoutingUnavailableError("ORS isochrones: unexpected response");
  const rings: Record<number, PolygonGeometry> = {};
  for (const feature of features) {
    const value = feature.properties?.value;
    if (feature.geometry?.type === "Polygon" && typeof value === "number") {
      rings[Math.round(value / 60)] = { type: "Polygon", coordinates: feature.geometry.coordinates };
    }
  }
  return rings;
}

/**
 * OpenRouteService foot-walking router. Every failure (no key, HTTP error, quota) is a
 * RoutingUnavailableError (with a `kind`, see classifyOrsError) so the prediction service can
 * fall back to estimates. Error messages carry only axios' `message`, never the request config (key).
 */
export function createOrsRouter(apiKey: string | undefined, deps: OrsDeps = {}): WalkingRouter {
  const post: HttpPost = deps.post ?? ((url, body, config) => axios.post(url, body, config));
  const schedule = deps.schedule ?? createThrottle(1000);
  const counters = deps.counters ?? {
    matrix: new DailyCounter(ORS_DAILY_LIMITS.matrix),
    directions: new DailyCounter(ORS_DAILY_LIMITS.directions),
    isochrones: new DailyCounter(ORS_DAILY_LIMITS.isochrones),
  };
  const budgets = deps.budgets ?? {
    matrix: new MinuteBudget(ORS_MINUTE_LIMITS.matrix),
    directions: new MinuteBudget(ORS_MINUTE_LIMITS.directions),
    isochrones: new MinuteBudget(ORS_MINUTE_LIMITS.isochrones),
  };

  async function call(endpoint: OrsEndpoint, path: string, body: unknown): Promise<unknown> {
    if (!apiKey) throw new RoutingUnavailableError("ORS_API_KEY is not set", { kind: "permanent" });
    return schedule(async () => {
      if (!counters[endpoint].tryConsume()) throw new RoutingUnavailableError(`ORS ${endpoint}: daily limit reached`);
      // Inside the 1 req/s queue: waiting here holds back later ORS calls too, keeping their order.
      await budgets[endpoint].acquire();
      try {
        const response = await post(`${ORS_BASE_URL}${path}`, body, {
          headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
            Accept: "application/json, application/geo+json",
            "User-Agent": USER_AGENT,
          },
          timeout: 15_000,
        });
        return response.data;
      } catch (error) {
        throw new RoutingUnavailableError(`ORS ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, { kind: classifyOrsError(error) });
      }
    });
  }

  return {
    async matrix(sources, destinations) {
      const data = await call("matrix", "/matrix/foot-walking", {
        locations: [...sources, ...destinations],
        sources: sources.map((_, index) => index),
        destinations: destinations.map((_, index) => sources.length + index),
        metrics: ["duration", "distance"],
        units: "m",
      });
      return parseOrsMatrix(data);
    },
    async route(a, b) {
      return parseOrsRoute(await call("directions", "/directions/foot-walking/geojson", { coordinates: [a, b] }));
    },
    async isochrones(center, rangesMin) {
      const data = await call("isochrones", "/isochrones/foot-walking", {
        locations: [center],
        range: rangesMin.map((minutes) => minutes * 60),
        range_type: "time",
      });
      return parseOrsIsochrones(data);
    },
  };
}
