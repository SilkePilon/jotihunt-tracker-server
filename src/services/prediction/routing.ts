import type { LngLat } from "./types";

/**
 * How a routing failure should be handled:
 * - `request`: only this request is bad (e.g. 400/404 "no routable point within 350 m").
 * - `permanent`: cannot resolve itself (no/invalid API key, 401/403); stop calling until the config changes.
 * - `temporary`: outage, rate limit, timeout or network error (429/5xx); retry after a cooldown.
 */
export type RoutingFailureKind = "request" | "permanent" | "temporary";

/** ORS could not answer: no key, HTTP error, quota. Callers fall back to estimates. */
export class RoutingUnavailableError extends Error {
  readonly kind: RoutingFailureKind;

  constructor(message: string, options: { kind?: RoutingFailureKind } = {}) {
    super(message);
    this.name = "RoutingUnavailableError";
    this.kind = options.kind ?? "temporary";
  }
}

export interface MatrixResult {
  /** durationsS[source][destination] in seconds; null when unreachable */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
}

export interface WalkingRouter {
  matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult>;
}
