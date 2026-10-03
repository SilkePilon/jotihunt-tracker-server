import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../logger";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  ERRORS_BEFORE_PAUSE,
  JotihuntApiError,
  JotihuntPausedError,
  getAreas,
  getArticlesPage,
  jotihuntPausedFor,
  parseRetryAfter,
  resetJotihuntBackoff,
  setJotihuntApiUrl,
} from "./jotihunt.service";

// A local stand-in for the Jotihunt API
let mode = "ok";
let hits = 0;
let lastQuery = "";
let timer: ReturnType<typeof setInterval> | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch(request) {
    hits++;
    lastQuery = new URL(request.url).search;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    switch (mode) {
      case "429":
        return new Response("Too Many Attempts.", { status: 429 });
      case "429-retry-after":
        return new Response("Too Many Attempts.", { status: 429, headers: { "retry-after": "600" } });
      case "500":
        return json({ message: "Server Error" }, 500);
      case "html":
        return new Response("<html>Just a moment...</html>", { headers: { "content-type": "text/html" } });
      case "nulls":
        return json({ data: [null, { name: "Alpha", status: "red", updated_at: "2026-10-17T10:00:00.000000Z" }, 7] });
      case "huge":
        return new Response(`{"data":["${"x".repeat(6 * 1024 * 1024)}"]}`, { headers: { "content-type": "application/json" } });
      case "trickle": {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            timer = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(" "));
              } catch {
                clearInterval(timer);
              }
            }, 100);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }
      default:
        return json({ data: [{ id: 1, title: "x", type: "news", publish_at: "2026-10-17T10:00:00.000000Z", message: { content: "c" } }], meta: { last_page: 4, per_page: 15 } });
    }
  },
});
setJotihuntApiUrl(`http://127.0.0.1:${server.port}`);

let now = Date.UTC(2026, 9, 17, 10, 0);
const logged: string[] = [];

beforeAll(() => {
  spyOn(logger, "error").mockImplementation(((message: unknown) => void logged.push(String(message))) as never);
  spyOn(logger, "warn").mockImplementation(((message: unknown) => void logged.push(String(message))) as never);
});
beforeEach(() => {
  mode = "ok";
  hits = 0;
  logged.length = 0;
  resetJotihuntBackoff(() => now);
});
afterAll(() => {
  mock.restore();
  resetJotihuntBackoff();
  clearInterval(timer);
  server.stop(true);
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
}

describe("Jotihunt API backoff", () => {
  test("a 429 pauses all calls for 1 minute, then 2, 4, 5 (max); a success resets it", async () => {
    mode = "429";
    expect(await failure(getAreas())).toBeInstanceOf(JotihuntApiError);
    expect(jotihuntPausedFor()).toBe(BACKOFF_BASE_MS);

    // Paused: no request at all, for any endpoint
    hits = 0;
    expect(await failure(getArticlesPage(1))).toBeInstanceOf(JotihuntPausedError);
    expect(hits).toBe(0);

    const pauses: number[] = [];
    for (let index = 0; index < 3; index++) {
      now += jotihuntPausedFor();
      await failure(getAreas());
      pauses.push(jotihuntPausedFor());
    }
    expect(pauses).toEqual([2 * BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS, BACKOFF_MAX_MS]);

    now += jotihuntPausedFor();
    mode = "ok";
    await getAreas();
    mode = "429";
    await failure(getAreas());
    expect(jotihuntPausedFor()).toBe(BACKOFF_BASE_MS);
  });

  test("a longer Retry-After wins", async () => {
    mode = "429-retry-after";
    await failure(getAreas());
    expect(jotihuntPausedFor()).toBe(600_000);
  });

  test("other errors pause only after a few in a row", async () => {
    mode = "500";
    for (let index = 1; index < ERRORS_BEFORE_PAUSE; index++) {
      await failure(getAreas());
      expect(jotihuntPausedFor()).toBe(0);
    }
    await failure(getAreas());
    expect(jotihuntPausedFor()).toBe(BACKOFF_BASE_MS);
  });

  test("an HTML page with status 200 is a failure, not data", async () => {
    mode = "html";
    const error = await failure(getAreas());
    expect(error).toBeInstanceOf(JotihuntApiError);
    expect(error.message).toContain("unexpected response");
  });

  test("parseRetryAfter reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(new Date(1_000_000 + 30_000).toUTCString(), 1_000_000)).toBe(30_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("Jotihunt API responses", () => {
  test("null and non-object entries are skipped", async () => {
    mode = "nulls";
    expect(await getAreas()).toEqual([{ name: "Alpha", status: "red", updated_at: "2026-10-17T10:00:00.000000Z" }]);
  });

  test("articles pages: page parameter and paging info", async () => {
    const page = await getArticlesPage(3);
    expect(lastQuery).toBe("?page=3");
    expect(page.lastPage).toBe(4);
    expect(page.perPage).toBe(15);
    expect(page.articles).toHaveLength(1);
  });

  test("a trickling answer is aborted by the total deadline (10 s), errors are logged as one short line", async () => {
    mode = "trickle";
    const started = Date.now();
    const error = await failure(getAreas());
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(error.message).toBe("Could not fetch areas (GET /areas → timeout)");
    expect(logged.some((line) => line === "Error fetching areas: GET /areas → timeout")).toBe(true);
    expect(logged.every((line) => line.length < 200)).toBe(true);
  }, 15_000);

  test("an answer above 5 MB is refused", async () => {
    mode = "huge";
    const error = await failure(getAreas());
    expect(error).toBeInstanceOf(JotihuntApiError);
  });
});
