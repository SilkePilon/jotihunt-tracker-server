import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { limitFailures, limitRate } from "./rate-limit";

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  });
  return res;
}

function attempt(limiter: (req: Request, res: Response, next: NextFunction) => unknown, email: string, status: number) {
  const res = fakeRes();
  let passed = false;
  limiter({ body: { email } } as Request, res as unknown as Response, (() => (passed = true)) as NextFunction);
  if (passed) {
    res.statusCode = status;
    res.emit("finish");
  }
  return { passed, res };
}

describe("limitFailures", () => {
  let clock = 0;
  const limiter = () =>
    limitFailures({ windowMs: 1000, maxFailures: 3, failureStatus: 401, key: (req) => String(req.body.email), now: () => clock });

  test("blocks a key after too many failures, until the window ends", () => {
    clock = 0;
    const limit = limiter();
    for (let i = 0; i < 3; i++) expect(attempt(limit, "a", 401).passed).toBe(true);
    const blocked = attempt(limit, "a", 401);
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(attempt(limit, "b", 401).passed).toBe(true);
    clock = 1001;
    expect(attempt(limit, "a", 401).passed).toBe(true);
  });

  test("a success clears the failures", () => {
    clock = 0;
    const limit = limiter();
    attempt(limit, "a", 401);
    attempt(limit, "a", 401);
    attempt(limit, "a", 200);
    for (let i = 0; i < 3; i++) expect(attempt(limit, "a", 401).passed).toBe(true);
  });
});

describe("limitFailures memory and per-address limits", () => {
  let clock = 0;

  test("keeps at most maxKeys keys, dropping the oldest", () => {
    clock = 0;
    const limit = limitFailures({ windowMs: 1000, maxFailures: 1, failureStatus: 401, maxKeys: 3, key: (req) => String(req.body.email), now: () => clock });
    for (const email of ["a", "b", "c", "d"]) attempt(limit, email, 401);
    // "a" was evicted when "d" came in, so it may try again; "d" is still blocked
    expect(attempt(limit, "a", 401).passed).toBe(true);
    expect(attempt(limit, "d", 401).passed).toBe(false);
  });

  test("resetOnSuccess false: a success does not clear the failures", () => {
    clock = 0;
    const limit = limitFailures({ windowMs: 1000, maxFailures: 2, failureStatus: 401, resetOnSuccess: false, key: () => "ip", now: () => clock });
    attempt(limit, "a", 401);
    attempt(limit, "b", 200);
    attempt(limit, "c", 401);
    expect(attempt(limit, "d", 401).passed).toBe(false);
  });
});

describe("limitRate", () => {
  let clock = 0;
  const limiter = (maxKeys?: number) => limitRate({ windowMs: 1000, max: 2, key: (req) => String(req.body.email), maxKeys, now: () => clock });

  test("allows max requests per key per window, then 429 with Retry-After", () => {
    clock = 0;
    const limit = limiter();
    expect(attempt(limit, "a", 201).passed).toBe(true);
    expect(attempt(limit, "a", 400).passed).toBe(true);
    const blocked = attempt(limit, "a", 201);
    expect(blocked.passed).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers["Retry-After"]).toBe("1");
    expect(attempt(limit, "b", 201).passed).toBe(true);
    clock = 1000;
    expect(attempt(limit, "a", 201).passed).toBe(true);
  });

  test("keeps at most maxKeys keys", () => {
    clock = 0;
    const limit = limiter(2);
    attempt(limit, "a", 201);
    attempt(limit, "a", 201);
    attempt(limit, "b", 201);
    attempt(limit, "c", 201);
    // "a" was evicted, so it starts over
    expect(attempt(limit, "a", 201).passed).toBe(true);
  });
});
