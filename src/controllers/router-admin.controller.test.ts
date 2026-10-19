import { afterEach, describe, expect, test } from "bun:test";
import { getRouterStatus, rebuildRouter } from "./router-admin.controller";

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(body: unknown) { res.body = body; return res; } };
  return res;
}

const saved = { url: process.env.ROUTER_URL, admin: process.env.ROUTER_ADMIN_URL };
afterEach(() => {
  if (saved.url === undefined) delete process.env.ROUTER_URL; else process.env.ROUTER_URL = saved.url;
  if (saved.admin === undefined) delete process.env.ROUTER_ADMIN_URL; else process.env.ROUTER_ADMIN_URL = saved.admin;
});

describe("router admin", () => {
  test("unconfigured status", async () => {
    delete process.env.ROUTER_URL;
    delete process.env.ROUTER_ADMIN_URL;
    const res = fakeRes();
    await getRouterStatus({} as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: false, online: false });
  });

  test("unreachable status", async () => {
    process.env.ROUTER_URL = "http://127.0.0.1:9";
    process.env.ROUTER_ADMIN_URL = "http://127.0.0.1:9";
    const res = fakeRes();
    await getRouterStatus({} as never, res as never);
    expect(res.body).toMatchObject({ configured: true, online: false, lastError: "Router niet bereikbaar" });
  });

  test("rebuild 503 when unconfigured or unreachable", async () => {
    delete process.env.ROUTER_ADMIN_URL;
    let res = fakeRes();
    await rebuildRouter({} as never, res as never);
    expect(res.statusCode).toBe(503);
    process.env.ROUTER_ADMIN_URL = "http://127.0.0.1:9";
    res = fakeRes();
    await rebuildRouter({} as never, res as never);
    expect(res.statusCode).toBe(503);
  });
});
