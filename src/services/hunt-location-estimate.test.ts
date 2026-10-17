import { describe, expect, test } from "bun:test";
import { estimateHuntLocation, huntReferenceTime, shouldTryEstimate, type TrackFix, type TrackerTrack } from "./hunt-location-estimate";
import type { AreaGroup } from "./intel-chat/geo";

/** Alpha's groups around Arnhem, Bravo's around Amersfoort */
const groups: AreaGroup[] = [
  { name: "A1", area: "alpha", lat: 51.98, lng: 5.9 },
  { name: "A2", area: "alpha", lat: 52.0, lng: 5.95 },
  { name: "A3", area: "alpha", lat: 51.96, lng: 5.96 },
  { name: "B1", area: "bravo", lat: 52.15, lng: 5.38 },
  { name: "B2", area: "bravo", lat: 52.17, lng: 5.42 },
  { name: "B3", area: "bravo", lat: 52.14, lng: 5.43 },
];
const IN_ALPHA = { lat: 51.98, lng: 5.93 };
const IN_BRAVO = { lat: 52.155, lng: 5.41 };
const time = new Date("2026-10-17T19:00:00Z");
const at = (minutes: number) => new Date(time.getTime() + minutes * 60_000);
const fix = (minutes: number, overrides: Partial<TrackFix> = {}): TrackFix => ({ ...IN_ALPHA, at: at(minutes), accuracy: 10, speedKmh: 0, ...overrides });
const track = (name: string, fixes: TrackFix[]): TrackerTrack => ({ name, fixes });
const estimate = (tracks: TrackerTrack[], area = "Alpha") => estimateHuntLocation({ area, time, tracks, groups });

describe("estimateHuntLocation", () => {
  test("a tracker in the hunt's area at the hunt time gives the estimate", () => {
    expect(estimate([track("Fiets 1", [fix(1)])])).toEqual({ ...IN_ALPHA, accuracy: 150, estimated: true, source: "Fiets 1" });
  });

  test("only trackers in the hunt's deelgebied count; none there → no estimate", () => {
    expect(estimate([track("Auto", [fix(0, IN_BRAVO)])])).toBeNull();
    expect(estimate([track("Auto", [fix(0, IN_BRAVO)]), track("Fiets", [fix(4)])])).toMatchObject({ source: "Fiets" });
    expect(estimate([track("Auto", [fix(0, IN_BRAVO)])], "bravo")).toMatchObject({ source: "Auto" });
  });

  test("the fix closest in time wins, across trackers; fixes more than 10 min away are ignored", () => {
    expect(estimate([track("Ver", [fix(-6)]), track("Dichtbij", [fix(2)])])).toMatchObject({ source: "Dichtbij" });
    expect(estimate([track("Oud", [fix(-11), fix(11)])])).toBeNull();
    // Per tracker its own closest fix is the one judged: here the one in Bravo, so this tracker is out
    expect(estimate([track("Rijdt weg", [fix(-8), fix(0.5, IN_BRAVO)])])).toBeNull();
  });

  test("a tie in time goes to the slowest tracker; unknown speed comes last", () => {
    expect(estimate([track("Rijdt", [fix(1, { speedKmh: 30 })]), track("Staat", [fix(-1, { speedKmh: 1 })])])).toMatchObject({ source: "Staat" });
    expect(estimate([track("Onbekend", [fix(1, { speedKmh: null })]), track("Loopt", [fix(1, { speedKmh: 5 })])])).toMatchObject({ source: "Loopt" });
  });

  test("accuracy: at least 150 m, else the fix's accuracy or how far the tracker moved in the window (max 1000 m)", () => {
    expect(estimate([track("T", [fix(0, { accuracy: 320 })])])?.accuracy).toBe(320);
    expect(estimate([track("T", [fix(0, { accuracy: null })])])?.accuracy).toBe(150);
    // ~600 m further east 4 minutes later
    const moved = estimate([track("T", [fix(0), fix(4, { lng: IN_ALPHA.lng + 0.0087 })])])!.accuracy;
    expect(moved).toBeGreaterThan(550);
    expect(moved).toBeLessThan(650);
    // Far away within the window: capped
    expect(estimate([track("T", [fix(0), fix(-9, { lat: 51.9 })])])?.accuracy).toBe(1000);
    // Outside the window (-10 … +5 min): not counted
    expect(estimate([track("T", [fix(0), fix(8, { lat: 51.9 })])])?.accuracy).toBe(150);
  });

  test("no trackers, no estimate", () => {
    expect(estimate([])).toBeNull();
    expect(estimate([track("Leeg", [])])).toBeNull();
  });
});

describe("when to try", () => {
  test("the hunt time, else first seen", () => {
    expect(huntReferenceTime({ huntTime: time, firstSeenAt: at(3) })).toEqual(time);
    expect(huntReferenceTime({ huntTime: null, firstSeenAt: at(3) })).toEqual(at(3));
    expect(huntReferenceTime({})).toBeNull();
  });

  test("at most once per minute, given up after 60 min", () => {
    expect(shouldTryEstimate(time, at(1), null)).toBe(true);
    expect(shouldTryEstimate(time, at(1.5), at(1))).toBe(false);
    expect(shouldTryEstimate(time, at(2), at(1))).toBe(true);
    expect(shouldTryEstimate(time, at(60), null)).toBe(true);
    expect(shouldTryEstimate(time, at(61), null)).toBe(false);
  });
});
