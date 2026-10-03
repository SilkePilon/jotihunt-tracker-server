import { describe, expect, test } from "bun:test";
import axios from "axios";
import { deadline, describeHttpError, withTotalDeadline } from "./http-limits";

function trickleServer() {
  let timer: ReturnType<typeof setInterval> | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("["));
          timer = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(" "));
            } catch {
              clearInterval(timer);
            }
          }, 50);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      clearInterval(timer);
      server.stop(true);
    },
  };
}

describe("withTotalDeadline", () => {
  test("ends a trickling response that axios' idle timeout never ends", async () => {
    const server = trickleServer();
    try {
      const client = withTotalDeadline(axios.create({ baseURL: server.url, timeout: 200 }), 500);
      const started = Date.now();
      const error = await client.get("/api/positions?token=secret").catch((caught: unknown) => caught);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(describeHttpError(error)).toBe("GET /api/positions → timeout");
    } finally {
      server.stop();
    }
  });

  test("a caller's own signal wins", async () => {
    const client = withTotalDeadline(axios.create(), 500);
    const own = new AbortController().signal;
    let seen: unknown;
    client.interceptors.request.use((config) => {
      seen = config.signal;
      throw new Error("stop");
    });
    await client.get("http://127.0.0.1:9/", { signal: own }).catch(() => undefined);
    expect(seen).toBe(own);
  });
});

describe("deadline", () => {
  test("rejects a promise that never settles", async () => {
    await expect(deadline(new Promise(() => {}), 50, "too slow")).rejects.toThrow("too slow");
    expect(await deadline(Promise.resolve(1), 50, "x")).toBe(1);
  });
});

describe("describeHttpError", () => {
  test("one short line, never headers or bodies", () => {
    const error = Object.assign(new axios.AxiosError("Request failed", "ERR_BAD_REQUEST"), {
      config: { method: "get", url: "/areas?key=secret", headers: { Authorization: "Bearer secret" } },
      response: { status: 429, data: "x".repeat(50_000) },
    });
    expect(describeHttpError(error)).toBe("GET /areas → 429");
    expect(describeHttpError(new Error("boom"))).toBe("boom");
  });
});
