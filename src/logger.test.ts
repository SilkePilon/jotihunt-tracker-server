import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";
import { AxiosError, AxiosHeaders } from "axios";
import Transport from "winston-transport";
import { createSentryErrorTransport, dropAccessLogs, errorDetails } from "./logger";
import { captureThrottled } from "./sentry";

/** A logger with the production format that collects the JSON lines. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = winston.createLogger({
    format: winston.format.combine(errorDetails(), winston.format.json()),
    transports: [new winston.transports.Stream({ stream })],
  });
  return { logger, lines };
}

describe("errorDetails log format", () => {
  test("an Error as the message (node-cron) logs its message and stack instead of {}", () => {
    const { logger, lines } = capture();
    // node-cron calls logger.error(error) with the Error itself as the message
    (logger.error as (message: unknown, meta?: unknown) => void)(new Error("boom"), undefined);
    expect(lines[0].message).toBe("boom");
    expect(String(lines[0].stack)).toContain("Error: boom");
  });

  test("an Error as meta keeps message and stack", () => {
    const { logger, lines } = capture();
    const error = Object.assign(new Error("kapot"), { code: "E1", huge: "x".repeat(10_000) });
    logger.error("Error doing x", error);
    expect(lines[0].message).toBe("Error doing x kapot");
    expect(String(lines[0].stack)).toContain("kapot");
    expect(lines[0].code).toBe("E1");
    expect(lines[0].huge).toBeUndefined();
  });

  test("an Error's cause is logged as its message only", () => {
    const { logger, lines } = capture();
    logger.error("Error doing y", new Error("outer", { cause: Object.assign(new Error("inner"), { big: "x".repeat(1000) }) }));
    expect(lines[0].cause).toBe("inner");
  });

  test("an axios error logs only message, method, url and status", () => {
    const { logger, lines } = capture();
    const config = { method: "get", url: "/api/areas", baseURL: "https://api.example.nl/", headers: new AxiosHeaders({ Authorization: "Bearer secret" }) };
    const error = new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", config, {}, {
      status: 500,
      statusText: "",
      data: "x".repeat(10_000),
      headers: {},
      config,
    });
    error.cause = Object.assign(new Error("connect ECONNREFUSED"), { address: "127.0.0.1", port: 9 });
    logger.error("Error fetching areas:", error);
    const line = lines[0];
    expect(line.message).toBe("Error fetching areas: Request failed with status code 500");
    expect(line).toMatchObject({ method: "GET", url: "https://api.example.nl/api/areas", status: 500, code: "ERR_BAD_RESPONSE" });
    expect(line.cause).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(JSON.stringify(line).length).toBeLessThan(500);
  });

  test("plain messages and meta are unchanged", () => {
    const { logger, lines } = capture();
    logger.info("Starting", { a: 1 });
    expect(lines[0]).toEqual({ level: "info", message: "Starting", a: 1 });
  });
});

describe("Sentry error transport", () => {
  function logWith(...args: unknown[][]) {
    const captured: unknown[][] = [];
    const log = winston.createLogger({
      format: winston.format.combine(errorDetails(), winston.format.json()),
      transports: [createSentryErrorTransport((...call) => captured.push(call))],
    });
    for (const [level, ...rest] of args) (log as unknown as Record<string, (...a: unknown[]) => void>)[level as string](...rest);
    return captured;
  }

  test("logger.error with an Error becomes an issue with the message as extra", async () => {
    const error = new Error("transport-a");
    const captured = logWith(["error", "Could not fetch areas", error]);
    await Bun.sleep(10);
    // Winston appends the meta error's message with a space
    expect(captured).toEqual([[error, { extra: { log: "Could not fetch areas transport-a" } }]]);
  });

  test("an Error passed as the message (node-cron) is captured too", async () => {
    const error = new Error("transport-b");
    // node-cron's logger adapter calls logger.error(error, undefined)
    const captured = logWith(["error", error, undefined]);
    await Bun.sleep(10);
    expect(captured[0]?.[0]).toBe(error);
  });

  test("an error the request handler or a cron wrapper already handled is not captured again", async () => {
    const error = new Error("transport-handled");
    captureThrottled(error, {}, "request", () => {});
    const captured = logWith(["error", "Unhandled error on GET /x", error]);
    await Bun.sleep(10);
    expect(captured).toEqual([]);
  });

  test("expected outages of external services are not captured", async () => {
    const named = (name: string) => Object.assign(new Error(`transport-${name}`), { name });
    const captured = logWith(
      ["error", "Jotihunt", named("JotihuntApiError")],
      ["error", "Jotihunt", named("JotihuntPausedError")],
      ["error", "Gemini", named("GeminiError")],
      ["error", "ORS", named("RoutingUnavailableError")],
      ["error", "AI answer", named("InvalidPredictionError")],
    );
    await Bun.sleep(10);
    expect(captured).toEqual([]);
  });

  test("no Error, warn level or database outage: not captured", async () => {
    const captured = logWith(
      ["error", "plain message"],
      ["warn", "careful", new Error("transport-c")],
      ["error", "db", Object.assign(new Error("transport-d"), { name: "MongoNetworkError" })],
    );
    await Bun.sleep(10);
    expect(captured).toEqual([]);
  });
});

describe("Sentry Logs access-log filter", () => {
  test("express-winston lines (request under meta) are dropped", () => {
    const format = dropAccessLogs();
    const info = { level: "warn", message: "HTTP GET /herstel/secret?x=1", meta: { req: { headers: { "cf-connecting-ip": "1.2.3.4" } }, res: { statusCode: 404 }, responseTime: 2 } };
    expect(format.transform(info)).toBe(false);
    expect(format.transform({ level: "error", message: "x", req: {} })).toBe(false);
  });

  test("other lines pass unchanged", () => {
    const info = { level: "error", message: "Could not store areas", stack: "Error: x" };
    expect(format().transform(info)).toBe(info);
    function format() {
      return dropAccessLogs();
    }
  });

  test("on a transport, access-log lines from the shared logger never arrive", async () => {
    const received: unknown[] = [];
    const sink = new (class extends Transport {
      log(info: unknown, next: () => void) {
        received.push(info);
        next();
      }
    })({ format: dropAccessLogs() });
    const log = winston.createLogger({ format: winston.format.combine(errorDetails(), winston.format.json()), transports: [sink] });
    // The shape express-winston 4 logs with (winstonInstance.log({ meta: { req, res, responseTime }, level, message }))
    log.log({ level: "warn", message: "HTTP POST /invites/code", meta: { req: { url: "/invites/code" }, res: { statusCode: 400 }, responseTime: 1 } });
    log.warn("Real warning");
    await Bun.sleep(10);
    expect(received).toHaveLength(1);
    expect((received[0] as { message: string }).message).toBe("Real warning");
  });
});
