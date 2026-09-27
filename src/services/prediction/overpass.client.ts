import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, type HttpPost, type Schedule } from "./http";
import type { Bbox, StopInput, StopKind, StopSource } from "./routing";

/** Main instance first, then a mirror (the main instance is often "too busy"). */
export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

interface RawElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

export function buildOverpassQuery([west, south, east, north]: Bbox): string {
  const box = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:90];(node["public_transport"="platform"]${box};node["railway"="station"]${box};node["highway"="bus_stop"]${box};);out body;`;
}

export function stopKind(tags: Record<string, string>): StopKind {
  if (tags.railway === "station" || tags.railway === "halt" || tags.train === "yes") return "train";
  if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
  if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
  return "other";
}

export function parseOverpassStops(data: unknown): StopInput[] {
  const elements = (data as { elements?: RawElement[] } | null)?.elements;
  if (!Array.isArray(elements)) throw new Error("Overpass: unexpected response");
  const stops = new Map<number, StopInput>();
  for (const element of elements) {
    if (element.type !== "node" || typeof element.id !== "number" || typeof element.lat !== "number" || typeof element.lon !== "number") continue;
    const tags = element.tags ?? {};
    stops.set(element.id, { osmId: element.id, name: tags.name ?? "Halte", kind: stopKind(tags), lng: element.lon, lat: element.lat });
  }
  return [...stops.values()];
}

/** Public-transport stops from OpenStreetMap via the Overpass API. */
export function createOverpassSource(deps: { post?: HttpPost; urls?: string[]; schedule?: Schedule } = {}): StopSource {
  const post: HttpPost = deps.post ?? ((url, body, config) => axios.post(url, body, config));
  const urls = deps.urls ?? OVERPASS_URLS;
  const schedule = deps.schedule ?? createThrottle(1000);
  return {
    async fetchStops(bbox) {
      const body = new URLSearchParams({ data: buildOverpassQuery(bbox) }).toString();
      let lastError: unknown;
      for (const url of urls) {
        try {
          const response = await schedule(() =>
            post(url, body, { headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT }, timeout: 120_000 }),
          );
          return parseOverpassStops(response.data);
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`Overpass unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    },
  };
}
