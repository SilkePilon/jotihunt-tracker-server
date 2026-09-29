import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RoutingCache } from "../../models/routing-cache.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { RoutingUnavailableError, type WalkingRouter } from "./routing";
import { straightLineRouter } from "./straight-line.router";
import type { LngLat } from "./types";
import { createWalkMinutes } from "./walking";

void RoutingCache;
const A: LngLat = [5.4866, 52.0806];
const B: LngLat = [5.5, 52.09];

function countingRouter(inner: WalkingRouter) {
  let calls = 0;
  return {
    router: { matrix: (s: LngLat[], d: LngLat[]) => (calls++, inner.matrix(s, d)) } as WalkingRouter,
    calls: () => calls,
  };
}
const failing = (kind: "request" | "permanent" | "temporary"): WalkingRouter => ({
  matrix: async () => {
    throw new RoutingUnavailableError("down", { kind });
  },
});

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("createWalkMinutes", () => {
  test("rounds ORS seconds to minutes and caches the result", async () => {
    const ors = countingRouter({ matrix: async () => ({ durationsS: [[600, 1250]], distancesM: [[0, 0]] }) });
    const walk = createWalkMinutes({ walking: ors.router, fallback: straightLineRouter });
    expect(await walk(A, [B, A])).toEqual({ minutes: [10, 21], estimate: false });
    expect(await walk(A, [B, A])).toEqual({ minutes: [10, 21], estimate: false });
    expect(ors.calls()).toBe(1);
  });

  test("falls back to straight line and flags estimate when ORS is down", async () => {
    const walk = createWalkMinutes({ walking: failing("temporary"), fallback: straightLineRouter });
    const result = await walk(A, [B]);
    expect(result.estimate).toBe(true);
    expect(result.minutes[0]).toBeGreaterThan(0);
  });

  test("a temporary failure opens the breaker: ORS is skipped until the cooldown ends", async () => {
    let now = 0;
    const ors = countingRouter(failing("temporary"));
    const walk = createWalkMinutes({ walking: ors.router, fallback: straightLineRouter, now: () => new Date(now) });
    await walk(A, [B]);
    await walk(B, [A]);
    expect(ors.calls()).toBe(1);
    now = 6 * 60 * 1000;
    await walk([5.6, 52.1], [A]);
    expect(ors.calls()).toBe(2);
  });

  test("null ORS durations use the straight-line estimate", async () => {
    const walk = createWalkMinutes({ walking: { matrix: async () => ({ durationsS: [[null]], distancesM: [[null]] }) }, fallback: straightLineRouter });
    const result = await walk(A, [B]);
    expect(result.minutes[0]).toBeGreaterThan(0);
  });
});
