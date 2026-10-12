import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { clientIpHeader } from "./client-ip-header";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", 1);
  // Mixed case on purpose: the header name must match case-insensitively
  app.use(clientIpHeader(" CF-Connecting-IP "));
  app.get("/", (req, res) => {
    res.send(req.ip);
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const ipFor = async (headers: Record<string, string>) => (await fetch(base, { headers })).text();

describe("clientIpHeader", () => {
  test("the configured header wins over X-Forwarded-For (the proxy's own address)", async () => {
    expect(await ipFor({ "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "10.42.1.73" })).toBe("203.0.113.7");
  });

  test("without the header, X-Forwarded-For is used unchanged", async () => {
    expect(await ipFor({ "X-Forwarded-For": "10.42.1.73" })).toBe("10.42.1.73");
  });

  test("surrounding spaces are trimmed", async () => {
    expect(await ipFor({ "cf-connecting-ip": "  198.51.100.4  " })).toBe("198.51.100.4");
  });

  test("an empty header is ignored", async () => {
    expect(await ipFor({ "cf-connecting-ip": " ", "X-Forwarded-For": "10.42.1.73" })).toBe("10.42.1.73");
  });

  test("an IPv6 address passes through", async () => {
    expect(await ipFor({ "cf-connecting-ip": "2001:db8::1", "X-Forwarded-For": "10.42.1.73" })).toBe("2001:db8::1");
  });
});
