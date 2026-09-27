import { describe, expect, mock, test } from "bun:test";
import { USER_AGENT } from "./constants";
import { DailyCounter, type HttpPost } from "./http";
import { createOrsRouter, parseOrsIsochrones, parseOrsMatrix, parseOrsRoute } from "./ors.client";
import { RoutingUnavailableError } from "./routing";

const sampleMatrix = {
  durations: [[0, 720.5, null]],
  distances: [[0, 1000.2, null]],
  sources: [{ location: [5.48, 52.08] }],
  destinations: [{ location: [5.48, 52.08] }, { location: [5.49, 52.08] }, { location: [5.5, 52.09] }],
};
const sampleRoute = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { summary: { distance: 1234.5, duration: 888.8 } },
      geometry: { type: "LineString", coordinates: [[5.48, 52.08], [5.485, 52.081], [5.49, 52.081]] },
    },
  ],
};
const ring = [[[5.48, 52.08], [5.49, 52.08], [5.49, 52.09], [5.48, 52.08]]];
const sampleIsochrones = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { group_index: 0, value: 600, center: [5.48, 52.08] }, geometry: { type: "Polygon", coordinates: ring } },
    { type: "Feature", properties: { group_index: 0, value: 1200, center: [5.48, 52.08] }, geometry: { type: "Polygon", coordinates: ring } },
  ],
};

const immediate = <T>(task: () => Promise<T>) => task();

describe("ORS parsers", () => {
  test("matrix", () => {
    expect(parseOrsMatrix(sampleMatrix)).toEqual({ durationsS: [[0, 720.5, null]], distancesM: [[0, 1000.2, null]] });
    expect(() => parseOrsMatrix({})).toThrow(RoutingUnavailableError);
  });

  test("directions", () => {
    const route = parseOrsRoute(sampleRoute);
    expect(route.line).toHaveLength(3);
    expect(route.distanceM).toBe(1234.5);
    expect(route.durationS).toBe(888.8);
    expect(() => parseOrsRoute({ features: [] })).toThrow(RoutingUnavailableError);
  });

  test("isochrones keyed by minutes", () => {
    const rings = parseOrsIsochrones(sampleIsochrones);
    expect(Object.keys(rings).map(Number)).toEqual([10, 20]);
    expect(rings[10]).toEqual({ type: "Polygon", coordinates: ring });
  });
});

describe("createOrsRouter", () => {
  test("rejects without an API key and never calls out", async () => {
    const post = mock<HttpPost>(async () => ({ data: sampleMatrix }));
    const router = createOrsRouter(undefined, { post, schedule: immediate });
    await expect(router.matrix([[5.48, 52.08]], [[5.49, 52.08]])).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(post).not.toHaveBeenCalled();
  });

  test("sends the matrix request with the key and user agent", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (url, body, config) => {
      calls.push({ url, body, headers: config.headers });
      return { data: sampleMatrix };
    };
    const router = createOrsRouter("secret", { post, schedule: immediate });
    const result = await router.matrix([[5.48, 52.08]], [[5.48, 52.08], [5.49, 52.08], [5.5, 52.09]]);
    expect(calls[0].url).toBe("https://api.openrouteservice.org/v2/matrix/foot-walking");
    expect(calls[0].body).toEqual({
      locations: [[5.48, 52.08], [5.48, 52.08], [5.49, 52.08], [5.5, 52.09]],
      sources: [0],
      destinations: [1, 2, 3],
      metrics: ["duration", "distance"],
      units: "m",
    });
    expect(calls[0].headers.Authorization).toBe("secret");
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(result.durationsS[0][1]).toBe(720.5);
  });

  test("requests directions and isochrones", async () => {
    const bodies: Record<string, unknown> = {};
    const post: HttpPost = async (url, body) => {
      bodies[url] = body;
      return { data: url.includes("isochrones") ? sampleIsochrones : sampleRoute };
    };
    const router = createOrsRouter("secret", { post, schedule: immediate });
    await router.route([5.48, 52.08], [5.49, 52.081]);
    await router.isochrones([5.48, 52.08], [10, 20]);
    expect(bodies["https://api.openrouteservice.org/v2/directions/foot-walking/geojson"]).toEqual({ coordinates: [[5.48, 52.08], [5.49, 52.081]] });
    expect(bodies["https://api.openrouteservice.org/v2/isochrones/foot-walking"]).toEqual({ locations: [[5.48, 52.08]], range: [600, 1200], range_type: "time" });
  });

  test("HTTP errors and exhausted quota become RoutingUnavailableError", async () => {
    const failing = createOrsRouter("secret", { post: async () => Promise.reject(new Error("403")), schedule: immediate });
    await expect(failing.route([5.48, 52.08], [5.49, 52.08])).rejects.toBeInstanceOf(RoutingUnavailableError);

    const post = mock<HttpPost>(async () => ({ data: sampleRoute }));
    const exhausted = createOrsRouter("secret", {
      post,
      schedule: immediate,
      counters: { matrix: new DailyCounter(0), directions: new DailyCounter(0), isochrones: new DailyCounter(0) },
    });
    await expect(exhausted.route([5.48, 52.08], [5.49, 52.08])).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(post).not.toHaveBeenCalled();
  });
});
