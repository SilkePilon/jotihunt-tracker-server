import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { logger } from "../logger";
import { forwardEnvelope, parseDsn } from "./sentry-tunnel.route";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const SITE_DSN = "https://pub@o42.ingest.de.sentry.io/7";
const envelope = (dsn: string) => Buffer.from(`${JSON.stringify({ dsn, sent_at: "2026-10-14T00:00:00Z" })}\n{"type":"event"}\n{}`);

describe("parseDsn", () => {
  test("host and project id", () => {
    expect(parseDsn(SITE_DSN)).toEqual({ host: "o42.ingest.de.sentry.io", projectId: "7" });
    expect(parseDsn("not a url")).toBeNull();
  });
});

describe("forwardEnvelope", () => {
  test("404 when the site DSN is not configured", async () => {
    expect((await forwardEnvelope(envelope(SITE_DSN), undefined)).status).toBe(404);
  });

  test("forwards an envelope of our project to its ingest URL", async () => {
    const calls: [string, RequestInit][] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await forwardEnvelope(envelope(SITE_DSN), SITE_DSN, fakeFetch);
    expect(result.status).toBe(200);
    expect(calls[0]![0]).toBe("https://o42.ingest.de.sentry.io/api/7/envelope/");
    expect(calls[0]![1].method).toBe("POST");
  });

  test("passes Sentry's rate limit headers back so the browser SDK backs off", async () => {
    const limited = (async () =>
      new Response("", { status: 429, headers: { "X-Sentry-Rate-Limits": "60:error:organization", "Retry-After": "60", "X-Other": "no" } })) as unknown as typeof fetch;
    const result = await forwardEnvelope(envelope(SITE_DSN), SITE_DSN, limited);
    expect(result.status).toBe(429);
    expect(result.headers).toEqual({ "x-sentry-rate-limits": "60:error:organization", "retry-after": "60" });

    const plain = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect((await forwardEnvelope(envelope(SITE_DSN), SITE_DSN, plain)).headers).toEqual({});
  });

  test("rejects other projects and hosts (no open relay)", async () => {
    const fakeFetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect((await forwardEnvelope(envelope("https://pub@o42.ingest.de.sentry.io/8"), SITE_DSN, fakeFetch)).status).toBe(400);
    expect((await forwardEnvelope(envelope("https://pub@evil.example/7"), SITE_DSN, fakeFetch)).status).toBe(400);
  });

  test("rejects a malformed envelope", async () => {
    expect((await forwardEnvelope(Buffer.from("garbage"), SITE_DSN)).status).toBe(400);
    expect((await forwardEnvelope(Buffer.alloc(0), SITE_DSN)).status).toBe(400);
    expect((await forwardEnvelope(Buffer.from('"just a string"\n{}'), SITE_DSN)).status).toBe(400);
    expect((await forwardEnvelope(Buffer.from("null\n{}"), SITE_DSN)).status).toBe(400);
  });

  test("502 when Sentry can not be reached", async () => {
    const warn = spyOn(logger, "warn").mockImplementation((() => logger) as never);
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await forwardEnvelope(envelope(SITE_DSN), SITE_DSN, failing)).status).toBe(502);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("POST /sentry-tunnel through the app", () => {
  let server: Server;
  let base: string;
  const originalDsn = process.env.SENTRY_SITE_DSN;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_SITE_DSN;
    else process.env.SENTRY_SITE_DSN = originalDsn;
  });
  afterAll(() => {
    server.close();
  });

  const post = (body: Buffer | string, contentType = "text/plain;charset=UTF-8") =>
    realFetch(`${base}/sentry-tunnel`, { method: "POST", headers: { "Content-Type": contentType }, body: typeof body === "string" ? body : new Uint8Array(body) });

  test("404 when SENTRY_SITE_DSN is unset", async () => {
    delete process.env.SENTRY_SITE_DSN;
    expect((await post(envelope(SITE_DSN))).status).toBe(404);
  });

  test("400 for an envelope of another project (the raw body reaches the route)", async () => {
    process.env.SENTRY_SITE_DSN = SITE_DSN;
    expect((await post(envelope("https://pub@o42.ingest.de.sentry.io/8"))).status).toBe(400);
  });

  test("400 for a JSON body (not swallowed by the JSON parser)", async () => {
    process.env.SENTRY_SITE_DSN = SITE_DSN;
    expect((await post(JSON.stringify({ dsn: SITE_DSN }), "application/json")).status).toBe(400);
  });

  test("413 above 1 MB", async () => {
    process.env.SENTRY_SITE_DSN = SITE_DSN;
    const warn = spyOn(logger, "warn").mockImplementation((() => logger) as never);
    expect((await post(Buffer.alloc(1024 * 1024 + 1, 0x61))).status).toBe(413);
    warn.mockRestore();
  });

  // The browser SDK posts text/plain; application/json proves the tunnel runs before the app's JSON parser
  test.each(["text/plain;charset=UTF-8", "application/json"])("forwards the exact envelope bytes (%s) and relays status and rate limit headers", async (contentType) => {
    process.env.SENTRY_SITE_DSN = SITE_DSN;
    const upstream: { url: string; body: Buffer }[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      upstream.push({ url, body: Buffer.from(init.body as Uint8Array) });
      return new Response('{"id":"abc"}', { status: 200, headers: { "X-Sentry-Rate-Limits": "60:replay:organization" } });
    }) as unknown as typeof fetch);
    try {
      const sent = envelope(SITE_DSN);
      const response = await post(sent, contentType);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"id":"abc"}');
      expect(response.headers.get("x-sentry-rate-limits")).toBe("60:replay:organization");
      expect(upstream).toHaveLength(1);
      expect(upstream[0]!.url).toBe("https://o42.ingest.de.sentry.io/api/7/envelope/");
      expect(upstream[0]!.body.equals(sent)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
