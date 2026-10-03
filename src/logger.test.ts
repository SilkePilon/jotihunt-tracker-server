import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";
import { AxiosError, AxiosHeaders } from "axios";
import { errorDetails } from "./logger";

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
