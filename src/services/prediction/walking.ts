import { createHash } from "node:crypto";
import { ORS_COOLDOWN_MS, ORS_REQUEST_FALLBACK_TTL_MS } from "./constants";
import { RoutingUnavailableError, type MatrixResult, type WalkingRouter } from "./routing";
import { readCacheEntry, writeCache } from "./routing-cache";
import { straightLineSeconds } from "./straight-line.router";
import type { LngLat } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WalkMinutes = (from: LngLat, to: LngLat[]) => Promise<{ minutes: number[]; estimate: boolean }>;

/** Stable cache key for a coordinate (~1 m precision). */
export function coordKey([lng, lat]: LngLat): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * Walking minutes from one point to many, via the ORS matrix. Results are cached for a day.
 * Circuit breaker (for the life of this instance): a permanent failure (no/rejected key) stops ORS for good;
 * a temporary failure skips ORS for ORS_COOLDOWN_MS; a request failure (400/404) caches the fallback for 6 h.
 */
export function createWalkMinutes(deps: { walking: WalkingRouter; fallback: WalkingRouter; now?: () => Date }): WalkMinutes {
  const now = deps.now ?? (() => new Date());
  const breaker: { permanent: boolean; openUntil: number | null } = { permanent: false, openUntil: null };

  async function matrix(key: string, from: LngLat, to: LngLat[]): Promise<{ result: MatrixResult; estimate: boolean }> {
    const hit = await readCacheEntry<MatrixResult>(key);
    if (hit) return { result: hit.value, estimate: hit.estimate };
    if (breaker.permanent || (breaker.openUntil !== null && now().getTime() < breaker.openUntil)) {
      return { result: await deps.fallback.matrix([from], to), estimate: true };
    }
    try {
      const result = await deps.walking.matrix([from], to);
      await writeCache(key, result, DAY_MS).catch(() => undefined); // the cache is best-effort
      breaker.openUntil = null;
      return { result, estimate: false };
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      const result = await deps.fallback.matrix([from], to);
      if (error.kind === "request") await writeCache(key, result, ORS_REQUEST_FALLBACK_TTL_MS, { estimate: true }).catch(() => undefined);
      else if (error.kind === "permanent") breaker.permanent = true;
      else breaker.openUntil = now().getTime() + ORS_COOLDOWN_MS;
      return { result, estimate: true };
    }
  }

  return async (from, to) => {
    if (to.length === 0) return { minutes: [], estimate: false };
    const key = `walk:${coordKey(from)}:${createHash("sha1").update(to.map(coordKey).join(";")).digest("hex")}`;
    const { result, estimate } = await matrix(key, from, to);
    const minutes = to.map((point, index) => Math.round((result.durationsS[0]?.[index] ?? straightLineSeconds(from, point)) / 60));
    return { minutes, estimate };
  };
}
