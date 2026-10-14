import { describe, expect, test } from "bun:test";
import { captureThrottled, createIssueThrottle, issueKey, reportCronErrors, reportRequestError, sentryOptions, shouldReportRequestError } from "./sentry";

describe("sentryOptions", () => {
  test("null without a DSN (tests, local dev)", () => {
    expect(sentryOptions({})).toBeNull();
    expect(sentryOptions({ SENTRY_DSN: "  " })).toBeNull();
  });

  test("errors only, nothing personal", () => {
    const options = sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", SENTRY_ENVIRONMENT: "production", SENTRY_RELEASE: "abc123" })!;
    expect(options.dsn).toBe("https://k@o1.ingest.sentry.io/2");
    expect(options.environment).toBe("production");
    expect(options.release).toBe("abc123");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.dataCollection).toEqual({
      userInfo: false,
      httpBodies: [],
      urlQueryParams: false,
      cookies: false,
      httpHeaders: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  test("environment falls back to NODE_ENV, then development", () => {
    expect(sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", NODE_ENV: "production" })!.environment).toBe("production");
    expect(sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" })!.environment).toBe("development");
  });
});

describe("issue throttle", () => {
  test("same key once per window", () => {
    let now = 0;
    const allow = createIssueThrottle(600_000, () => now);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);
    now = 600_001;
    expect(allow("a")).toBe(true);
  });

  test("issueKey uses context, error name and message", () => {
    expect(issueKey(new TypeError("boom"), "cron:x")).toBe("cron:x|TypeError|boom");
    expect(issueKey("plain")).toBe("|string|plain");
  });

  test("captureThrottled sends a repeated error only once", () => {
    const sent: unknown[] = [];
    const capture = (error: unknown) => sent.push(error);
    captureThrottled(new Error("same"), {}, "t1", capture);
    captureThrottled(new Error("same"), {}, "t1", capture);
    expect(sent).toHaveLength(1);
  });
});

describe("request errors", () => {
  test("only 5xx that are not a database outage", () => {
    expect(shouldReportRequestError(new Error("bug"), 500)).toBe(true);
    expect(shouldReportRequestError(new Error("nope"), 404)).toBe(false);
    expect(shouldReportRequestError(Object.assign(new Error("x"), { name: "MongoNetworkError" }), 500)).toBe(false);
  });

  test("sends route and user id + name", () => {
    const calls: unknown[][] = [];
    const error = new Error("req-bug");
    reportRequestError(error, { method: "GET", originalUrl: "/hunts/1", user: { _id: "u1", name: "Fox" } }, (...args) => calls.push(args));
    expect(calls).toEqual([[error, { tags: { route: "GET /hunts/1" }, user: { id: "u1", username: "Fox" } }]]);
  });
});

describe("reportCronErrors", () => {
  test("captures with the cron tag and rethrows", async () => {
    const calls: unknown[][] = [];
    const error = new Error("cron-bug");
    const job = reportCronErrors("areas", async () => {
      throw error;
    }, (...args) => calls.push(args));
    await expect(job()).rejects.toBe(error);
    expect(calls).toEqual([[error, { tags: { cron: "areas" } }]]);
  });

  test("passes arguments and result through", async () => {
    const job = reportCronErrors("x", async (n: number) => n * 2, () => {});
    expect(await job(21)).toBe(42);
  });
});
