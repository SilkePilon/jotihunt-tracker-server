import { describe, expect, test } from "bun:test";
import { USER_AGENT } from "./constants";
import type { HttpPost } from "./http";
import { buildOverpassQuery, createOverpassSource, parseOverpassStops, stopKind } from "./overpass.client";

const sample = {
  version: 0.6,
  elements: [
    { type: "node", id: 649245603, lat: 52.0802008, lon: 5.4740582, tags: { highway: "bus_stop", name: "Pluimenweg", public_transport: "platform" } },
    { type: "node", id: 42, lat: 52.0908, lon: 5.1102, tags: { railway: "station", name: "Utrecht Centraal" } },
    { type: "node", id: 43, lat: 52.09, lon: 5.12, tags: { railway: "tram_stop", public_transport: "platform" } },
    { type: "node", id: 42, lat: 52.0908, lon: 5.1102, tags: { railway: "station", name: "Utrecht Centraal" } },
    { type: "way", id: 7, tags: { railway: "station" } },
  ],
};

describe("overpass", () => {
  test("query covers platforms, stations and bus stops in the bbox (south,west,north,east)", () => {
    const query = buildOverpassQuery([5.1, 52.0, 5.6, 52.2]);
    expect(query).toBe(
      '[out:json][timeout:90];(node["public_transport"="platform"](52,5.1,52.2,5.6);node["railway"="station"](52,5.1,52.2,5.6);node["highway"="bus_stop"](52,5.1,52.2,5.6););out body;',
    );
  });

  test("stopKind", () => {
    expect(stopKind({ railway: "station" })).toBe("train");
    expect(stopKind({ public_transport: "platform", train: "yes" })).toBe("train");
    expect(stopKind({ railway: "tram_stop" })).toBe("tram");
    expect(stopKind({ highway: "bus_stop" })).toBe("bus");
    expect(stopKind({ public_transport: "platform" })).toBe("other");
  });

  test("parses nodes, deduplicates and names unnamed stops", () => {
    expect(parseOverpassStops(sample)).toEqual([
      { osmId: 649245603, name: "Pluimenweg", kind: "bus", lng: 5.4740582, lat: 52.0802008 },
      { osmId: 42, name: "Utrecht Centraal", kind: "train", lng: 5.1102, lat: 52.0908 },
      { osmId: 43, name: "Halte", kind: "tram", lng: 5.12, lat: 52.09 },
    ]);
  });

  test("falls back to the next URL and sends a form body with the user agent", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (url, body, config) => {
      calls.push({ url, body, headers: config.headers });
      if (url === "https://a.example/api/interpreter") throw new Error("504");
      return { data: sample };
    };
    const source = createOverpassSource({ post, urls: ["https://a.example/api/interpreter", "https://b.example/api/interpreter"], schedule: (task) => task() });
    const stops = await source.fetchStops([5.1, 52.0, 5.6, 52.2]);
    expect(stops).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual(["https://a.example/api/interpreter", "https://b.example/api/interpreter"]);
    expect(String(calls[1].body).startsWith("data=%5Bout%3Ajson%5D")).toBe(true);
    expect(calls[1].headers["User-Agent"]).toBe(USER_AGENT);
  });

  test("throws when every URL fails", async () => {
    const source = createOverpassSource({ post: async () => Promise.reject(new Error("504")), urls: ["https://a.example"], schedule: (task) => task() });
    await expect(source.fetchStops([5.1, 52.0, 5.6, 52.2])).rejects.toThrow("Overpass unavailable");
  });
});
