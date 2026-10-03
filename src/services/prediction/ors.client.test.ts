import { describe, expect, mock, test } from "bun:test";
import { USER_AGENT } from "./constants";
import { createThrottle, DailyCounter, MinuteBudget, type HttpPost } from "./http";
import { createOrsRouter, ORS_MINUTE_LIMITS, parseOrsMatrix } from "./ors.client";
import { RoutingUnavailableError } from "./routing";

const sampleMatrix = {
  durations: [[0, 720.5, null]],
  distances: [[0, 1000.2, null]],
  sources: [{ location: [5.48, 52.08] }],
  destinations: [{ location: [5.48, 52.08] }, { location: [5.49, 52.08] }, { location: [5.5, 52.09] }],
};

const immediate = <T>(task: () => Promise<T>) => task();

describe("ORS parsers", () => {
  test("matrix", () => {
    expect(parseOrsMatrix(sampleMatrix)).toEqual({ durationsS: [[0, 720.5, null]], distancesM: [[0, 1000.2, null]] });
    expect(() => parseOrsMatrix({})).toThrow(RoutingUnavailableError);
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
    const calls: { url: string; body: unknown; headers: Record<string, string>; config: Parameters<HttpPost>[2] }[] = [];
    const post: HttpPost = async (url, body, config) => {
      calls.push({ url, body, headers: config.headers, config });
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
    // A total deadline (axios' timeout is idle-only under Bun) and a response size cap
    expect(calls[0].config.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].config.maxContentLength).toBeGreaterThan(0);
  });

  test("HTTP errors and exhausted quota become RoutingUnavailableError", async () => {
    const failing = createOrsRouter("secret", { post: async () => Promise.reject(new Error("403")), schedule: immediate });
    await expect(failing.matrix([[5, 52]], [[5.1, 52]])).rejects.toBeInstanceOf(RoutingUnavailableError);

    const post = mock<HttpPost>(async () => ({ data: sampleMatrix }));
    const exhausted = createOrsRouter("secret", {
      post,
      schedule: immediate,
      counters: { matrix: new DailyCounter(0) },
    });
    await expect(exhausted.matrix([[5, 52]], [[5.1, 52]])).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("ORS error classification", () => {
  /** An axios-like error; the config carries the key to prove it never reaches the message. */
  function httpError(status: number | undefined, message: string, code?: string) {
    return Object.assign(new Error(message), {
      code,
      config: { headers: { Authorization: "secret" } },
      response: status === undefined ? undefined : { status, data: { error: { code: 2010, message: "Could not find routable point within a radius of 350.0 meters" } } },
    });
  }

  async function failureFor(error: unknown) {
    const router = createOrsRouter("secret", { post: async () => Promise.reject(error), schedule: immediate });
    try {
      await router.matrix([[5, 52]], [[5.1, 52]]);
    } catch (caught) {
      return caught as RoutingUnavailableError;
    }
    throw new Error("expected a failure");
  }

  test("400 and 404 are request-specific", async () => {
    for (const status of [400, 404]) {
      const error = await failureFor(httpError(status, `Request failed with status code ${status}`));
      expect(error).toBeInstanceOf(RoutingUnavailableError);
      expect(error.kind).toBe("request");
    }
  });

  test("401 and 403 are permanent", async () => {
    for (const status of [401, 403]) {
      const error = await failureFor(httpError(status, `Request failed with status code ${status}`));
      expect(error.kind).toBe("permanent");
    }
  });

  test("429, 5xx, timeouts and network errors are temporary", async () => {
    const errors = [
      httpError(429, "Request failed with status code 429"),
      httpError(500, "Request failed with status code 500"),
      httpError(503, "Request failed with status code 503"),
      httpError(undefined, "timeout of 15000ms exceeded", "ECONNABORTED"),
      httpError(undefined, "getaddrinfo ENOTFOUND api.openrouteservice.org", "ENOTFOUND"),
      new Error("socket hang up"),
    ];
    for (const raw of errors) expect((await failureFor(raw)).kind).toBe("temporary");
  });

  test("a missing key is permanent", async () => {
    const router = createOrsRouter(undefined, { post: async () => ({ data: sampleMatrix }), schedule: immediate });
    await expect(router.matrix([[5, 52]], [[5.1, 52]])).rejects.toMatchObject({ kind: "permanent" });
  });

  test("the error message never contains the API key", async () => {
    for (const status of [400, 401, 429, undefined]) {
      const error = await failureFor(httpError(status, "Request failed"));
      expect(error.message).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });
});

describe("ORS per-minute budgets", () => {
  test("uses the free-plan per-minute limits", () => {
    expect(ORS_MINUTE_LIMITS).toEqual({ matrix: 40 });
  });

  test("an exhausted endpoint waits for the minute to roll over instead of failing", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const time = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    const post = mock<HttpPost>(async () => ({ data: sampleMatrix }));
    const router = createOrsRouter("secret", {
      post,
      schedule: immediate,
      budgets: { matrix: new MinuteBudget(2, time) },
    });
    await router.matrix([[5, 52]], [[5.1, 52]]);
    await router.matrix([[5, 52]], [[5.1, 52]]);
    expect(sleeps).toEqual([]);
    await router.matrix([[5, 52]], [[5.1, 52]]);
    expect(sleeps).toEqual([60_000]);
    expect(post).toHaveBeenCalledTimes(3);
  });

  test("keeps ≥1 req/s spacing after a per-minute budget wait (fake clock)", async () => {
    let clock = 0;
    const time = {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
    // Real MinuteBudget instance (values are irrelevant), with `acquire` overridden so the second
    // call alone waits ~45 s for the per-minute budget — simulating a burst hitting the limit.
    const matrixBudget = new MinuteBudget(1, time);
    let acquireCalls = 0;
    matrixBudget.acquire = async () => {
      acquireCalls++;
      if (acquireCalls === 2) await time.sleep(45_000);
    };

    const sendTimes: number[] = [];
    const post: HttpPost = async () => {
      sendTimes.push(clock);
      return { data: sampleMatrix };
    };
    const router = createOrsRouter("secret", {
      post,
      schedule: createThrottle(1000, time),
      budgets: { matrix: matrixBudget },
    });

    await router.matrix([[5, 52]], [[5.1, 52]]);
    await router.matrix([[5, 52]], [[5.1, 52]]); // waits ~45 s for the budget before sending
    await router.matrix([[5, 52]], [[5.1, 52]]); // must still be ≥ 1 s behind the previous *send*

    expect(sendTimes).toEqual([0, 45_000, 46_000]);
    expect(sendTimes[2] - sendTimes[1]).toBeGreaterThanOrEqual(1000);
  });
});
