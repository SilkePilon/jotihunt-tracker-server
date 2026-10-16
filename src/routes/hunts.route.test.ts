import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent } from "../models/hunt-sync-event.model";
import { User } from "../models/user.model";
import { storeHunts } from "../crons/jotihunt-scraper.cron";
import { signDeviceToken } from "../services/access-token";
import { markSyncStart, markSyncSuccess, resetSyncState } from "../services/hunt-sync-state";
import type { ScrapedHunt } from "../services/jotihunt-hunts.parse";
import { invalidateResponseCache } from "../services/response-cache";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

let server: Server;
let base: string;

beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  resetSyncState();
  invalidateResponseCache("hunts");
});
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const webUser = async () => tokenFor(await withSession(await User.create({ name: "Hunter" })));
async function deviceToken() {
  const user = await User.create({ name: "Phone", devices: [{ id: "dev-1", name: "Pixel", createdAt: new Date() }] });
  return signDeviceToken(user, "dev-1");
}

const huntTime = new Date("2026-10-17T19:43:00Z");
const scraped = (siteKey: string, overrides: Partial<ScrapedHunt> = {}): ScrapedHunt => ({
  siteKey,
  area: "alpha",
  huntTime,
  huntTimeText: "21:43",
  status: "pending",
  statusText: "Wacht op bevestiging",
  points: 0,
  qrCode: siteKey.replace(/^qr:/, ""),
  huntCode: null,
  location: { lat: 52.0123, lng: 5.9876, accuracy: 12 },
  detailUrl: null,
  ...overrides,
});

describe("hunt sync routes", () => {
  test("need a token; a web session and a device token both work", async () => {
    for (const path of ["/hunts", "/hunts/sync", "/hunts/events"]) expect((await get(path)).status).toBe(401);
    const web = await webUser();
    const device = await deviceToken();
    for (const path of ["/hunts", "/hunts/sync", "/hunts/events"]) {
      expect((await get(path, web)).status).toBe(200);
      expect((await get(path, device)).status).toBe(200);
    }
  });

  test("GET /hunts/sync: state, counts and points", async () => {
    const token = await webUser();
    expect(await (await get("/hunts/sync", token)).json()).toEqual({ configured: expect.any(Boolean), running: false, lastSuccessAt: null, lastAttemptAt: null, lastError: null, counts: { approved: 0, pending: 0, rejected: 0, total: 0 }, points: 0 });

    await storeHunts([scraped("qr:A", { status: "approved", points: 10 }), scraped("qr:B"), scraped("qr:C", { status: "rejected" }), scraped("qr:D", { status: "unknown", points: 0 }), scraped("qr:E", { status: "approved", points: 5, area: "delta" })]);
    const start = new Date("2026-10-17T19:50:00Z");
    markSyncStart(start);
    markSyncSuccess(new Date("2026-10-17T19:50:04Z"));
    expect(await (await get("/hunts/sync", token)).json()).toEqual({
      configured: expect.any(Boolean),
      running: false,
      lastSuccessAt: "2026-10-17T19:50:04.000Z",
      lastAttemptAt: start.toISOString(),
      lastError: null,
      counts: { approved: 2, pending: 2, rejected: 1, total: 5 },
      points: 15,
    });
  });

  test("GET /hunts: the synced hunt view", async () => {
    const now = new Date("2026-10-17T19:50:00Z");
    await storeHunts([scraped("qr:A")], now);
    const later = new Date("2026-10-17T19:55:00Z");
    await storeHunts([scraped("qr:A", { status: "approved", statusText: "Goedgekeurd", points: 10 })], later);
    invalidateResponseCache("hunts");
    const body = (await (await get("/hunts", await webUser())).json()) as unknown[];
    const stored = await Hunt.findOne({ siteKey: "qr:A" }).lean();
    expect(body).toEqual([
      {
        _id: String(stored!._id),
        siteKey: "qr:A",
        area: "alpha",
        huntTime: huntTime.toISOString(),
        status: "approved",
        statusText: "Goedgekeurd",
        points: 10,
        qrCode: "A",
        location: { lat: 52.0123, lng: 5.9876, accuracy: 12 },
        firstSeenAt: now.toISOString(),
        statusChangedAt: later.toISOString(),
      },
    ]);
  });

  test("GET /hunts: hunts stored before the sync get a class from their text", async () => {
    await Hunt.collection.insertOne({ siteKey: "code:OLD", area: "Bravo", huntCode: "OLD", status: "Goedgekeurd", points: 6, huntTime, updatedAt: huntTime });
    const [hunt] = (await (await get("/hunts", await webUser())).json()) as Record<string, unknown>[];
    expect(hunt).toMatchObject({ siteKey: "code:OLD", area: "bravo", status: "approved", statusText: "Goedgekeurd", qrCode: null, location: null, firstSeenAt: huntTime.toISOString(), statusChangedAt: null });
  });

  test("GET /hunts/events: newest first, the contract shape, paged with before", async () => {
    const token = await deviceToken();
    await storeHunts([scraped("qr:A")], new Date("2026-10-17T19:50:00Z"));
    await storeHunts([scraped("qr:A", { status: "approved", points: 10 }), scraped("qr:B", { area: "echo", location: null })], new Date("2026-10-17T19:51:00Z"));
    await storeHunts([scraped("qr:A", { status: "approved", points: 15 }), scraped("qr:B", { area: "echo", status: "rejected", location: null })], new Date("2026-10-17T19:52:00Z"));

    const all = (await (await get("/hunts/events", token)).json()) as Record<string, unknown>[];
    expect(all.map((event) => [event.area, event.type, event.points])).toEqual([
      ["echo", "rejected", null],
      ["alpha", "points", 15],
      ["echo", "new", null],
      ["alpha", "approved", 10],
      ["alpha", "new", null],
    ]);
    const hunt = await Hunt.findOne({ siteKey: "qr:A" }).lean();
    expect(all[1]).toEqual({ _id: expect.any(String), huntId: String(hunt!._id), area: "alpha", type: "points", points: 15, at: "2026-10-17T19:52:00.000Z", huntTime: huntTime.toISOString(), location: { lat: 52.0123, lng: 5.9876, accuracy: 12 } });
    expect(all[0].location).toBeNull();

    const page = (await (await get("/hunts/events?limit=2", token)).json()) as { at: string }[];
    expect(page).toHaveLength(2);
    const older = (await (await get(`/hunts/events?limit=2&before=${encodeURIComponent(page[1].at)}`, token)).json()) as { type: string }[];
    expect(older.map((event) => event.type)).toEqual(["new", "approved"]);
  });

  test("GET /hunts/events: a deleted hunt keeps the logged location", async () => {
    await storeHunts([scraped("qr:A")], new Date("2026-10-17T19:50:00Z"));
    await Hunt.deleteMany({});
    const [event] = (await (await get("/hunts/events", await webUser())).json()) as Record<string, unknown>[];
    expect(event.location).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: 12 });
    expect(await HuntSyncEvent.countDocuments()).toBe(1);
  });

  test("GET /hunts/events: bad query is 400", async () => {
    const token = await webUser();
    expect((await get("/hunts/events?limit=0", token)).status).toBe(400);
    expect((await get("/hunts/events?before=gisteren", token)).status).toBe(400);
  });
});
