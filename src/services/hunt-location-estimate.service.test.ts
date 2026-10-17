import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hunt } from "../models/hunt.model";
import { HuntSyncEvent } from "../models/hunt-sync-event.model";
import { Marker } from "../models/marker.model";
import { storeAndSync, storeHunts } from "../crons/jotihunt-scraper.cron";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { estimateHuntLocations, forgetEstimateAttempts, type EstimateSources } from "./hunt-location-estimate.service";
import type { TrackerTrack } from "./hunt-location-estimate";
import type { AreaGroup } from "./intel-chat/geo";
import type { ScrapedHunt } from "./jotihunt-hunts.parse";

const groups: AreaGroup[] = [
  { name: "A1", area: "alpha", lat: 51.98, lng: 5.9 },
  { name: "A2", area: "alpha", lat: 52.0, lng: 5.95 },
  { name: "A3", area: "alpha", lat: 51.96, lng: 5.96 },
  { name: "B1", area: "bravo", lat: 52.15, lng: 5.38 },
  { name: "B2", area: "bravo", lat: 52.17, lng: 5.42 },
  { name: "B3", area: "bravo", lat: 52.14, lng: 5.43 },
];
const IN_ALPHA = { lat: 51.98, lng: 5.93 };
const huntTime = new Date("2026-10-17T19:00:00Z");
const at = (minutes: number) => new Date(huntTime.getTime() + minutes * 60_000);

const scraped = (siteKey: string, overrides: Partial<ScrapedHunt> = {}): ScrapedHunt => ({
  siteKey,
  area: "alpha",
  huntTime,
  huntTimeText: "2026-10-17 21:00:00",
  status: "pending",
  statusText: "Wacht op bevestiging",
  points: 0,
  huntCode: null,
  location: null,
  ...overrides,
});

/** Fake trackers: every call is recorded; `tracks` is what they answer */
function fakeSources(tracks: TrackerTrack[]) {
  const calls: { from: Date; to: Date }[] = [];
  const sources: EstimateSources = {
    loadTracks: async (from, to) => {
      calls.push({ from, to });
      return tracks;
    },
    loadGroups: async () => groups,
  };
  return { sources, calls };
}
const fiets = (minutes = 1): TrackerTrack => ({ name: "Fiets 1", fixes: [{ ...IN_ALPHA, at: at(minutes), accuracy: 20, speedKmh: 2 }] });

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  forgetEstimateAttempts();
});
afterAll(disconnectTestDb);

describe("estimateHuntLocations", () => {
  test("a recent hunt without a location gets the estimate, and so do its log entries", async () => {
    await storeHunts([scraped("time:alpha:1"), scraped("time:bravo:1", { area: "bravo" })], at(1));
    const { sources, calls } = fakeSources([fiets()]);
    expect(await estimateHuntLocations(at(2), sources)).toBe(1);
    const location = { ...IN_ALPHA, accuracy: 150, estimated: true, source: "Fiets 1" };
    expect((await Hunt.findOne({ siteKey: "time:alpha:1" }).lean())!.location).toEqual(location);
    expect((await Hunt.findOne({ siteKey: "time:bravo:1" }).lean())!.location).toBeNull();
    expect((await HuntSyncEvent.find({ siteKey: "time:alpha:1" }).lean()).map((event) => event.location)).toEqual([location]);
    // The window asked of the trackers: 10 min before … 5 min after the hunt time
    expect(calls[0]).toEqual({ from: at(-10), to: at(5) });
  });

  test("a hunt without a hunt time uses when it was first seen", async () => {
    await storeHunts([scraped("raw:alpha:?", { huntTime: null, huntTimeText: "?" })], at(0));
    const { sources, calls } = fakeSources([fiets(0)]);
    expect(await estimateHuntLocations(at(1), sources)).toBe(1);
    expect(calls[0]).toEqual({ from: at(-10), to: at(5) });
  });

  test("no match: tried again after a minute, never more often, given up after 60 min", async () => {
    await storeHunts([scraped("time:alpha:1")], at(1));
    const { sources, calls } = fakeSources([]);
    await estimateHuntLocations(at(1), sources);
    await estimateHuntLocations(at(1.5), sources);
    expect(calls).toHaveLength(1);
    await estimateHuntLocations(at(2), sources);
    expect(calls).toHaveLength(2);
    await estimateHuntLocations(at(61), sources);
    expect(calls).toHaveLength(2);
    expect((await Hunt.findOne().lean())!.location).toBeNull();
  });

  test("a hunt that has a location (from anywhere) is left alone", async () => {
    const reported = { lat: 52.01, lng: 5.97, accuracy: 8 };
    await storeHunts([scraped("time:alpha:1", { location: reported })], at(1));
    const { sources, calls } = fakeSources([fiets()]);
    expect(await estimateHuntLocations(at(2), sources)).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await Hunt.findOne().lean())!.location).toMatchObject({ ...reported, estimated: false, source: null });
  });

  test("several due hunts: the trackers are asked once, for the window around all of them", async () => {
    await storeHunts([scraped("time:alpha:1"), scraped("time:alpha:2", { huntTime: at(20) }), scraped("time:bravo:1", { area: "bravo", huntTime: at(8) })], at(21));
    const { sources, calls } = fakeSources([fiets(1), { name: "Fiets 2", fixes: [{ ...IN_ALPHA, at: at(19), accuracy: 20, speedKmh: 1 }] }]);
    expect(await estimateHuntLocations(at(22), sources)).toBe(2);
    expect(calls).toEqual([{ from: at(-10), to: at(25) }]);
    // Each hunt only sees the fixes of its own window
    expect((await Hunt.findOne({ siteKey: "time:alpha:1" }).lean())!.location).toMatchObject({ source: "Fiets 1" });
    expect((await Hunt.findOne({ siteKey: "time:alpha:2" }).lean())!.location).toMatchObject({ source: "Fiets 2" });
  });

  test("a failing tracker source ends the run quietly; the hunts are tried again next minute", async () => {
    await storeHunts([scraped("time:alpha:1"), scraped("time:alpha:2", { huntTime: at(3) })], at(4));
    let fail = true;
    const sources: EstimateSources = {
      loadTracks: async () => {
        if (fail) throw new Error("Traccar down");
        return [fiets(3)];
      },
      loadGroups: async () => groups,
    };
    expect(await estimateHuntLocations(at(4), sources)).toBe(0);
    fail = false;
    expect(await estimateHuntLocations(at(5), sources)).toBe(2);
  });

  test("a live position (Life360) counts within 10 minutes of the hunt time, also after it", async () => {
    await storeHunts([scraped("time:alpha:1")], at(1));
    const { sources } = fakeSources([{ name: "Sanne", live: true, fixes: [{ ...IN_ALPHA, at: at(8), accuracy: 30, speedKmh: 0 }] }]);
    expect(await estimateHuntLocations(at(8), sources)).toBe(1);
    expect((await Hunt.findOne().lean())!.location).toMatchObject({ source: "Sanne" });
  });
});

describe("storeAndSync (the scraper cron after a scrape)", () => {
  test("stores, estimates, then makes the hunt marker (source jotihunt, externalId = siteKey)", async () => {
    // storeAndSync works on the real clock: the hunt happened a minute ago
    const recent = new Date(Date.now() - 60_000);
    const { sources } = fakeSources([{ name: "Fiets 1", fixes: [{ ...IN_ALPHA, at: recent, accuracy: 20, speedKmh: 2 }] }]);
    const result = await storeAndSync([scraped("time:alpha:1", { huntTime: recent })], { estimate: (at) => estimateHuntLocations(at, sources) });
    expect(result.events.map((event) => event.type)).toEqual(["new"]);
    const markers = await Marker.find().lean();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ area: "alpha", source: "jotihunt", externalId: "time:alpha:1", location: { type: "Point", coordinates: [IN_ALPHA.lng, IN_ALPHA.lat] } });
  });

  test("a slow estimate is cut off by its deadline; the markers are still made", async () => {
    const recent = new Date(Date.now() - 60_000);
    await storeAndSync([scraped("time:alpha:1", { huntTime: recent, location: { lat: 51.98, lng: 5.93, accuracy: 10 } })], { estimate: () => new Promise<number>(() => {}), estimateDeadlineMs: 50 });
    expect(await Marker.countDocuments()).toBe(1);
  });

  test("an estimate that fails never breaks the store", async () => {
    await storeAndSync([scraped("time:alpha:1")], {
      estimate: async () => {
        throw new Error("boom");
      },
    });
    expect(await Hunt.countDocuments()).toBe(1);
  });
});
