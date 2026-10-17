import { describe, expect, test } from "bun:test";
import type { ScrapedHunt } from "./jotihunt-hunts.parse";
import { diffHunts, isInitialImport } from "./hunt-sync-diff";

const now = new Date("2026-10-17T19:50:00Z");
const scraped = (siteKey: string, overrides: Partial<ScrapedHunt> = {}): ScrapedHunt => ({
  siteKey,
  area: "alpha",
  huntTime: new Date("2026-10-17T19:43:00Z"),
  huntTimeText: "21:43",
  status: "pending",
  statusText: "Wacht op bevestiging",
  points: 0,
  huntCode: null,
  location: null,
  ...overrides,
});
const stored = (siteKey: string, statusClass: string, points = 0, extra: { lastNotifiedOutcome?: "approved" | "rejected" | null; lastNotifiedPoints?: number | null } = {}) => ({ siteKey, statusClass, points, ...extra });

describe("diffHunts", () => {
  test("a new hunt is 'new'", () => {
    expect(diffHunts([], [scraped("qr:A")], now)).toEqual([{ siteKey: "qr:A", area: "alpha", type: "new", points: null, at: now }]);
  });

  test("a new hunt that is already judged: 'new' and then its outcome", () => {
    expect(diffHunts([stored("qr:X", "pending")], [scraped("qr:X"), scraped("qr:A", { area: "delta", status: "approved", points: 10 }), scraped("qr:B", { status: "rejected" })], now)).toEqual([
      { siteKey: "qr:A", area: "delta", type: "new", points: null, at: now },
      { siteKey: "qr:A", area: "delta", type: "approved", points: 10, at: now },
      { siteKey: "qr:B", area: "alpha", type: "new", points: null, at: now },
      { siteKey: "qr:B", area: "alpha", type: "rejected", points: null, at: now },
    ]);
  });

  test("status changes to approved or rejected", () => {
    const events = diffHunts([stored("qr:A", "pending"), stored("qr:B", "pending"), stored("qr:C", "approved", 5)], [scraped("qr:A", { status: "approved", points: 10 }), scraped("qr:B", { status: "rejected" }), scraped("qr:C", { status: "rejected" })], now);
    expect(events.map(({ siteKey, type, points }) => [siteKey, type, points])).toEqual([
      ["qr:A", "approved", 10],
      ["qr:B", "rejected", null],
      ["qr:C", "rejected", null],
    ]);
  });

  test("points changed while approved", () => {
    expect(diffHunts([stored("qr:A", "approved", 10)], [scraped("qr:A", { status: "approved", points: 15 })], now)).toEqual([{ siteKey: "qr:A", area: "alpha", type: "points", points: 15, at: now }]);
  });

  test("nothing changed, or a change to pending/unknown: no events", () => {
    expect(diffHunts([stored("qr:A", "pending"), stored("qr:B", "approved", 10)], [scraped("qr:A"), scraped("qr:B", { status: "approved", points: 10 })], now)).toEqual([]);
    expect(diffHunts([stored("qr:A", "approved", 10)], [scraped("qr:A", { status: "unknown", points: 0 })], now)).toEqual([]);
  });

  test("flapping through unknown/pending never repeats an outcome or a points change", () => {
    const flapped = stored("qr:A", "unknown", 0, { lastNotifiedOutcome: "approved", lastNotifiedPoints: 10 });
    expect(diffHunts([flapped], [scraped("qr:A", { status: "approved", points: 10 })], now)).toEqual([]);
    expect(diffHunts([stored("qr:A", "approved", 10)], [scraped("qr:A", { status: "unknown", points: 0 })], now)).toEqual([]);
    expect(diffHunts([stored("qr:A", "pending", 0, { lastNotifiedOutcome: "approved", lastNotifiedPoints: 10 })], [scraped("qr:A", { status: "rejected" })], now).map(({ type }) => type)).toEqual(["rejected"]);
    expect(diffHunts([flapped], [scraped("qr:A", { status: "approved", points: 12 })], now)).toEqual([{ siteKey: "qr:A", area: "alpha", type: "points", points: 12, at: now }]);
  });

  test("an initial import emits only 'new'", () => {
    const events = diffHunts([], [scraped("qr:A", { status: "approved", points: 10 }), scraped("qr:B", { status: "rejected" })], now, { initial: true });
    expect(events.map(({ type }) => type)).toEqual(["new", "new"]);
  });
});

describe("isInitialImport", () => {
  test("an empty database receiving more than one hunt", () => {
    expect(isInitialImport(0, 5)).toBe(true);
    expect(isInitialImport(0, 1)).toBe(false);
    expect(isInitialImport(3, 5)).toBe(false);
  });
});
