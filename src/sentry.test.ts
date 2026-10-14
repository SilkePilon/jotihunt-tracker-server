import { describe, expect, test } from "bun:test";
import { wasHandled, captureThrottled, createIssueThrottle, isAccessLog, issueKey, redactPath, reportCronErrors, reportRequestError, sentryOptions, shouldReportRequestError } from "./sentry";

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
    // In v11 any defined value (even 0) records spans; absent means no tracing
    expect(options.tracesSampleRate).toBeUndefined();
    expect("tracesSampleRate" in options).toBe(false);
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

  test("beforeSendLog drops access-log lines and keeps other logs", () => {
    const options = sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" })!;
    const log = (attributes: Record<string, unknown>) => ({ level: "warn" as const, message: "x", attributes });
    expect(options.beforeSendLog!(log({ meta: { req: { url: "/herstel/secret" }, res: { statusCode: 404 } } }))).toBeNull();
    expect(options.beforeSendLog!(log({ req: { url: "/" } }))).toBeNull();
    const kept = log({ code: "E1", stack: "Error: boom" });
    expect(options.beforeSendLog!(kept)).toBe(kept);
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

  test("issueKey ignores numbers in the message, so varying counts and ids share a key", () => {
    expect(issueKey(new Error("Timeout after 10000 ms for area 3"), "c")).toBe("c|Error|Timeout after # ms for area #");
    expect(issueKey(new Error("took 1.5 s"))).toBe(issueKey(new Error("took 12.25 s")));
  });

  test("captureThrottled sends a repeated error only once", () => {
    const sent: unknown[] = [];
    const capture = (error: unknown) => sent.push(error);
    captureThrottled(new Error("same"), {}, "t1", capture);
    captureThrottled(new Error("same"), {}, "t1", capture);
    expect(sent).toHaveLength(1);
  });

  test("a throttled error is still marked as handled (its log line must not report it again)", () => {
    const first = new Error("marked");
    const second = new Error("marked");
    captureThrottled(first, {}, "t2", () => {});
    captureThrottled(second, {}, "t2", () => {});
    expect(wasHandled(first)).toBe(true);
    expect(wasHandled(second)).toBe(true);
    expect(wasHandled(new Error("marked"))).toBe(false);
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

  test("the route tag has no query string, tokens or ids", () => {
    const calls: unknown[][] = [];
    const error = new Error("req-bug-redacted");
    reportRequestError(error, { method: "POST", originalUrl: "/herstel/s3cr3t/no-passkey?x=1" }, (...args) => calls.push(args));
    expect(calls).toEqual([[error, { tags: { route: "POST /herstel/:token/no-passkey" } }]]);
  });

  test("repeats are throttled by error, not by route", () => {
    const calls: unknown[][] = [];
    const capture = (...args: unknown[]) => calls.push(args);
    reportRequestError(new Error("req-bug-repeat"), { method: "GET", originalUrl: "/hunts/1" }, capture);
    reportRequestError(new Error("req-bug-repeat"), { method: "GET", originalUrl: "/teams/2" }, capture);
    expect(calls).toHaveLength(1);
  });
});

describe("redactPath", () => {
  test("drops the query string", () => {
    expect(redactPath("/api/locations?token=secret&x=1")).toBe("/api/locations");
  });

  test("replaces secrets in the path", () => {
    expect(redactPath("/herstel/abc-DEF_123")).toBe("/herstel/:token");
    expect(redactPath("/herstel/abc/register/options")).toBe("/herstel/:token/register/options");
    expect(redactPath("/invites/xyz/register/no-passkey")).toBe("/invites/:code/register/no-passkey");
    expect(redactPath("/auth/qr/scan/q1w2e3/approve")).toBe("/auth/qr/scan/:code/approve");
  });

  test("replaces ObjectIds", () => {
    expect(redactPath("/admin/invites/65a1b2c3d4e5f6a7b8c9d0e1")).toBe("/admin/invites/:id");
    expect(redactPath("/hunt-reports/65A1B2C3D4E5F6A7B8C9D0E1/photo")).toBe("/hunt-reports/:id/photo");
    expect(redactPath("/auth/qr/65a1b2c3d4e5f6a7b8c9d0e1")).toBe("/auth/qr/:id");
  });

  test("leaves other paths alone", () => {
    expect(redactPath("/hunts")).toBe("/hunts");
    expect(redactPath("/hints/12/Alpha/claim")).toBe("/hints/12/Alpha/claim");
  });
});

describe("isAccessLog", () => {
  test("express-winston lines carry the request under meta", () => {
    expect(isAccessLog({ meta: { req: {}, res: {}, responseTime: 3 } })).toBe(true);
    expect(isAccessLog({ req: {} })).toBe(true);
    expect(isAccessLog({ res: {} })).toBe(true);
    expect(isAccessLog({ code: "E1" })).toBe(false);
    expect(isAccessLog({ meta: "x" })).toBe(false);
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

describe("sentryOptions beforeSend", () => {
  type TestEvent = { request?: { url?: string }; transaction?: string; message?: string };
  const beforeSend = (event: TestEvent) => (sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" })!.beforeSend as unknown as (e: TestEvent) => TestEvent)(event);

  test("redacts an absolute request URL and drops the query", () => {
    const event = beforeSend({ request: { url: "https://x.example/herstel/abc123?q=1" } });
    expect(event.request?.url).toBe("https://x.example/herstel/:token");
  });

  test("redacts a bare path and the transaction name", () => {
    const event = beforeSend({ request: { url: "/invites/secret?x=1" }, transaction: "GET /herstel/abc123" });
    expect(event.request?.url).toBe("/invites/:code");
    expect(event.transaction).toBe("GET /herstel/:token");
  });

  test("leaves an event without a request untouched", () => {
    const event = { message: "boom" };
    expect(beforeSend(event)).toEqual({ message: "boom" });
  });
});
