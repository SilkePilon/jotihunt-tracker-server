import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { storeHunts } from "../crons/jotihunt-scraper.cron";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { AppNotification } from "../models/notification.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import type { ScrapedHunt } from "./jotihunt-hunts.parse";
import { notifyHuntEvents, syncHuntMarkers } from "./hunt-sync.service";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const huntTime = new Date("2026-10-17T19:43:00Z");
const now = new Date("2026-10-17T19:50:00Z");
const location = { lat: 52.0123, lng: 5.9876, accuracy: 12 };
const scraped = (siteKey: string, overrides: Partial<ScrapedHunt> = {}): ScrapedHunt => ({
  siteKey,
  area: "alpha",
  huntTime,
  huntTimeText: "21:43",
  status: "pending",
  statusText: "Wacht op bevestiging",
  points: 0,
  qrCode: null,
  huntCode: null,
  location,
  detailUrl: null,
  ...overrides,
});
const huntMarkers = () => Marker.find({ source: "jotihunt" }).sort({ externalId: 1 }).lean();

describe("syncHuntMarkers", () => {
  test("one hunt marker per hunt with a location, at the hunt time", async () => {
    await storeHunts([scraped("qr:A"), scraped("qr:B", { area: "delta", location: null })], now);
    expect(await syncHuntMarkers()).toEqual({ created: 1, updated: 0, deleted: 0 });
    const [marker] = await huntMarkers();
    expect(marker).toMatchObject({ area: "alpha", type: MarkerType.Hunt, time: huntTime, externalId: "qr:A", location: { type: "Point", coordinates: [5.9876, 52.0123] } });
    // Nothing changed: no writes
    expect(await syncHuntMarkers()).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  test("moves with the location, appears when a location arrives, goes with the hunt", async () => {
    await storeHunts([scraped("qr:A"), scraped("qr:B", { location: null })], now);
    await syncHuntMarkers();
    await storeHunts([scraped("qr:A", { location: { lat: 52.1, lng: 5.9, accuracy: null } }), scraped("qr:B", { location: { lat: 52.2, lng: 5.8, accuracy: 5 } })], now);
    expect(await syncHuntMarkers()).toEqual({ created: 1, updated: 1, deleted: 0 });
    expect((await huntMarkers()).map((marker) => marker.location.coordinates)).toEqual([
      [5.9, 52.1],
      [5.8, 52.2],
    ]);
    await Hunt.deleteOne({ siteKey: "qr:A" });
    expect(await syncHuntMarkers()).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect((await huntMarkers()).map((marker) => marker.externalId)).toEqual(["qr:B"]);
  });

  test("no synced marker next to an app-reported hunt marker of the same fox within 15 min", async () => {
    await Marker.create({ area: "alpha", time: new Date(huntTime.getTime() + 10 * 60_000), type: MarkerType.Hunt, location: { type: "Point", coordinates: [5.9, 52.1] } });
    await storeHunts([scraped("qr:A"), scraped("qr:B", { huntTime: new Date(huntTime.getTime() + 60 * 60_000) }), scraped("qr:C", { area: "delta" })], now);
    expect(await syncHuntMarkers()).toEqual({ created: 2, updated: 0, deleted: 0 });
    expect((await huntMarkers()).map((marker) => marker.externalId)).toEqual(["qr:B", "qr:C"]);
    // Stable: not created on the next run either
    expect(await syncHuntMarkers()).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  test("leaves other markers alone", async () => {
    await Marker.create({ area: "alpha", time: huntTime, type: MarkerType.Hunt, location: { type: "Point", coordinates: [5.9, 52.1] } });
    await Marker.create({ area: "alpha", time: huntTime, type: MarkerType.Hunt, location: { type: "Point", coordinates: [5.9, 52.1] }, source: "jotiboard", externalId: "pin1" });
    await syncHuntMarkers();
    expect(await Marker.countDocuments()).toBe(2);
  });
});

describe("notifyHuntEvents", () => {
  const sent: string[] = [];
  const send = async (notification: { title: string }) => void sent.push(notification.title);
  beforeEach(() => void (sent.length = 0));

  test("hunt in, approved, rejected; no push for points changes", async () => {
    await storeHunts([scraped("qr:X")], now);
    const first = await storeHunts([scraped("qr:X"), scraped("qr:A")], now);
    expect((await notifyHuntEvents(first, { now, send })).map((notification) => notification.title)).toEqual(["Hunt Alpha binnengekomen"]);
    const second = await storeHunts([scraped("qr:X", { status: "rejected" }), scraped("qr:A", { status: "approved", points: 10 })], now);
    const created = await notifyHuntEvents(second, { now, send });
    expect(created.map((notification) => [notification.type, notification.title])).toEqual([
      ["hunt-rejected", "Hunt Alpha afgekeurd"],
      ["hunt-approved", "Hunt Alpha goedgekeurd · +10"],
    ]);
    const third = await storeHunts([scraped("qr:X", { status: "rejected" }), scraped("qr:A", { status: "approved", points: 12 })], now);
    expect(third.events.map((event) => event.type)).toEqual(["points"]);
    expect(await notifyHuntEvents(third, { now, send })).toEqual([]);
    await Bun.sleep(5);
    expect(sent).toHaveLength(3);
  });

  test("an initial import pushes nothing", async () => {
    const result = await storeHunts([scraped("qr:A"), scraped("qr:B")], now);
    expect(result.initial).toBe(true);
    expect(await notifyHuntEvents(result, { now, send })).toEqual([]);
    expect(await AppNotification.countDocuments()).toBe(0);
  });

  test("a hunt first seen hours after its time pushes nothing, also not its outcome", async () => {
    await storeHunts([scraped("qr:X")], now);
    const old = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const result = await storeHunts([scraped("qr:X"), scraped("qr:OLD", { huntTime: old }), scraped("qr:OLD2", { huntTime: old, area: "delta", status: "approved", points: 10 })], now);
    expect(result.events.map(({ type }) => type)).toEqual(["new", "new", "approved"]);
    expect(await notifyHuntEvents(result, { now, send })).toEqual([]);
  });

  test("an old hunt that is judged later still pushes its outcome", async () => {
    const old = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    await storeHunts([scraped("qr:X")], now);
    await storeHunts([scraped("qr:X"), scraped("qr:OLD", { huntTime: old })], now);
    const result = await storeHunts([scraped("qr:X"), scraped("qr:OLD", { huntTime: old, status: "rejected" })], now);
    expect((await notifyHuntEvents(result, { now, send })).map((notification) => notification.type)).toEqual(["hunt-rejected"]);
  });
});
