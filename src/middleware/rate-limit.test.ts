import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { limitFailures } from "./rate-limit";

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

function attempt(limiter: ReturnType<typeof limitFailures>, email: string, status: number) {
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
