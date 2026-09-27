import { describe, expect, test } from "bun:test";
import { USER_AGENT } from "./constants";
import type { HttpGet } from "./http";
import { TransitUnavailableError } from "./routing";
import { createTransitousPlanner, parseTransitousPlan } from "./transitous.client";

// Trimmed from a real response (Scherpenzeel → Utrecht, probed 2026-09-27)
const sample = {
  itineraries: [
    {
      duration: 4800,
      startTime: "2026-09-28T10:22:00Z",
      endTime: "2026-09-28T11:42:00Z",
      transfers: 1,
      legs: [
        {
          mode: "WALK",
          from: { name: "START", lat: 52.0806, lon: 5.4866, departure: "2026-09-28T10:22:00Z" },
          to: { name: "Scherpenzeel, Kerk", lat: 52.079647, lon: 5.487466, arrival: "2026-09-28T10:25:00Z" },
        },
        {
          mode: "BUS",
          from: { name: "Scherpenzeel, Kerk", lat: 52.079647, lon: 5.487466, departure: "2026-09-28T10:25:00Z" },
          to: { name: "De Klomp, Stat. Veenendaal-De Klomp", lat: 52.046036, lon: 5.573803, arrival: "2026-09-28T10:39:00Z" },
          routeShortName: "80",
          displayName: "80",
          headsign: "Veenendaal",
        },
        {
          mode: "REGIONAL_RAIL",
          from: { name: "Veenendaal-De Klomp", lat: 52.045963, lon: 5.5734963, departure: "2026-09-28T11:07:00Z" },
          to: { name: "Utrecht Centraal", lat: 52.09009, lon: 5.110244, arrival: "2026-09-28T11:26:00Z" },
          routeShortName: "Intercity",
          displayName: "Intercity",
        },
        {
          mode: "WALK",
          from: { name: "Utrecht Centraal", lat: 52.09009, lon: 5.110244, departure: "2026-09-28T11:26:00Z" },
          to: { name: "END", lat: 52.0907, lon: 5.1214, arrival: "2026-09-28T11:42:00Z" },
        },
      ],
    },
    {
      startTime: "2026-09-28T10:30:00Z",
      endTime: "2026-09-28T12:10:00Z",
      legs: [{ mode: "WALK", from: { name: "START", lat: 52.0806, lon: 5.4866 }, to: { name: "END", lat: 52.0907, lon: 5.1214 } }],
    },
  ],
  direct: [],
};

describe("parseTransitousPlan", () => {
  test("picks the earliest arrival and maps legs", () => {
    const itinerary = parseTransitousPlan(sample)!;
    expect(itinerary.endTime).toEqual(new Date("2026-09-28T11:42:00Z"));
    expect(itinerary.legs.map((leg) => [leg.mode, leg.line])).toEqual([
      ["WALK", null],
      ["BUS", "80"],
      ["REGIONAL_RAIL", "Intercity"],
      ["WALK", null],
    ]);
    expect(itinerary.legs[1].to).toEqual({
      name: "De Klomp, Stat. Veenendaal-De Klomp",
      lng: 5.573803,
      lat: 52.046036,
      arrival: new Date("2026-09-28T10:39:00Z"),
      departure: null,
    });
  });

  test("null when there are no itineraries, error on garbage", () => {
    expect(parseTransitousPlan({ itineraries: [], direct: [] })).toBeNull();
    expect(() => parseTransitousPlan("<html>")).toThrow(TransitUnavailableError);
  });
});

describe("createTransitousPlanner", () => {
  test("sends lat,lon places, ISO time and the user agent only", async () => {
    const calls: { url: string; params: Record<string, string>; headers: Record<string, string> }[] = [];
    const get: HttpGet = async (url, config) => {
      calls.push({ url, params: config.params, headers: config.headers });
      return { data: sample };
    };
    const planner = createTransitousPlanner({ get, schedule: (task) => task() });
    const itinerary = await planner.plan([5.4866, 52.0806], [5.1214, 52.0907], new Date("2026-09-28T10:00:00Z"));
    expect(itinerary?.legs).toHaveLength(4);
    expect(calls[0].url).toBe("https://api.transitous.org/api/v5/plan");
    expect(calls[0].params).toEqual({ fromPlace: "52.0806,5.4866", toPlace: "52.0907,5.1214", time: "2026-09-28T10:00:00.000Z" });
    expect(calls[0].headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json" });
  });

  test("network errors become TransitUnavailableError", async () => {
    const planner = createTransitousPlanner({ get: async () => Promise.reject(new Error("ECONNRESET")), schedule: (task) => task() });
    await expect(planner.plan([5.48, 52.08], [5.12, 52.09], new Date())).rejects.toBeInstanceOf(TransitUnavailableError);
  });
});
