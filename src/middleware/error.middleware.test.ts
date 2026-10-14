import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Request, Response } from "express";
import { logger } from "../logger";
import { errorHandler, isDatabaseUnavailable } from "./error.middleware";

const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

describe("isDatabaseUnavailable", () => {
  test("connection errors of the driver and mongoose", () => {
    for (const name of ["MongoNetworkError", "MongoServerSelectionError", "MongooseServerSelectionError", "MongoNotConnectedError", "MongoTopologyClosedError", "MongoPoolClearedError", "MongoNetworkTimeoutError"]) {
      expect(isDatabaseUnavailable(named(name))).toBe(true);
    }
    expect(isDatabaseUnavailable(named("MongooseError", "Operation `users.findOne()` buffering timed out after 10000ms"))).toBe(true);
  });

  test("other errors are not", () => {
    expect(isDatabaseUnavailable(new Error("bug"))).toBe(false);
    expect(isDatabaseUnavailable(named("MongoServerError", "E11000 duplicate key"))).toBe(false);
    expect(isDatabaseUnavailable(named("ValidationError"))).toBe(false);
    expect(isDatabaseUnavailable("MongoNetworkError")).toBe(false);
  });
});

describe("errorHandler", () => {
  // spyOn instead of mock.module("../logger"): a module mock is process-wide in bun and would replace the real
  // logger for src/logger.test.ts when the files run in the same process
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation((() => logger) as never);
    error = spyOn(logger, "error").mockImplementation((() => logger) as never);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  function fakeRes() {
    const res = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string>, headersSent: false } as {
      statusCode: number;
      body: unknown;
      headers: Record<string, string>;
      headersSent: boolean;
      status(code: number): typeof res;
      json(body: unknown): typeof res;
      setHeader(name: string, value: string): typeof res;
    };
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (body) => ((res.body = body), res);
    res.setHeader = (name, value) => ((res.headers[name] = value), res);
    return res;
  }
  const handle = (err: unknown) => {
    const req = { method: "POST", originalUrl: "/api/locations?token=secret&x=1" } as unknown as Request;
    const res = fakeRes();
    errorHandler(err, req, res as unknown as Response, () => {});
    return res;
  };
  const withStatus = (status: number, message: string) => Object.assign(new Error(message), { status });

  test("a 4xx error is a warning, not an error, and its message is passed through", () => {
    const err = withStatus(400, "Bad JSON");
    const res = handle(err);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["Unhandled error on POST /api/locations", err]);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Bad JSON" });
  });

  test("a 413 from body-parser is a warning too", () => {
    handle(Object.assign(withStatus(413, "request entity too large"), { type: "entity.too.large" }));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a 5xx error is logged at error, without the query string, and hides its message", () => {
    const err = new Error("boom");
    const res = handle(err);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual(["Unhandled error on POST /api/locations", err]);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
  });

  test("a database outage is logged at error and answers 503 with Retry-After", () => {
    const res = handle(named("MongoNetworkError"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect(res.body).toEqual({ message: "Database niet bereikbaar" });
  });
});
