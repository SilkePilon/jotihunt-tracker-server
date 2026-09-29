import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, DailyCounter, MinuteBudget, type HttpPost, type Schedule } from "./http";
import { RoutingUnavailableError, type MatrixResult, type RoutingFailureKind, type WalkingRouter } from "./routing";

export const ORS_BASE_URL = "https://api.openrouteservice.org/v2";
/** Free-plan daily quotas per endpoint; beyond these we fall back to estimates. */
export const ORS_DAILY_LIMITS = { matrix: 500 } as const;
/** Free-plan per-minute limits per endpoint; a burst beyond these is queued, not failed. */
export const ORS_MINUTE_LIMITS = { matrix: 40 } as const;
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
  };
  const budgets = deps.budgets ?? {
    matrix: new MinuteBudget(ORS_MINUTE_LIMITS.matrix),
  };

  async function call(endpoint: OrsEndpoint, path: string, body: unknown): Promise<unknown> {
    if (!apiKey) throw new RoutingUnavailableError("ORS_API_KEY is not set", { kind: "permanent" });
    // Acquire the per-minute budget before entering the 1 req/s throttle, so a budget wait never
    // lands inside the throttle's timing window: the throttle's lastStart is only ever set right
    // before a request is actually sent, keeping the ≥ 1 s spacing even after a budget wait.
    await budgets[endpoint].acquire();
    return schedule(async () => {
      if (!counters[endpoint].tryConsume()) throw new RoutingUnavailableError(`ORS ${endpoint}: daily limit reached`);
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
  };
}
