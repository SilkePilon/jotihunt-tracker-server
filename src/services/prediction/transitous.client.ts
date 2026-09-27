import axios from "axios";
import { USER_AGENT } from "./constants";
import { createThrottle, type HttpGet, type Schedule } from "./http";
import { TransitUnavailableError, type TransitItinerary, type TransitPlace, type TransitPlanner } from "./routing";

export const TRANSITOUS_PLAN_URL = "https://api.transitous.org/api/v5/plan";

interface RawPlace {
  name?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
}

interface RawLeg {
  mode?: string;
  from?: RawPlace;
  to?: RawPlace;
  displayName?: string;
  routeShortName?: string;
}

interface RawItinerary {
  startTime?: string;
  endTime?: string;
  legs?: RawLeg[];
}

function toPlace(raw: RawPlace | undefined): TransitPlace {
  return {
    name: raw?.name ?? "",
    lng: raw?.lon ?? 0,
    lat: raw?.lat ?? 0,
    arrival: raw?.arrival ? new Date(raw.arrival) : null,
    departure: raw?.departure ? new Date(raw.departure) : null,
  };
}

/** The itinerary that arrives first, or null when Transitous found none. */
export function parseTransitousPlan(data: unknown): TransitItinerary | null {
  const itineraries = (data as { itineraries?: RawItinerary[] } | null)?.itineraries;
  if (!Array.isArray(itineraries)) throw new TransitUnavailableError("Transitous: unexpected response");
  const parsed = itineraries
    .filter((itinerary) => itinerary.startTime && itinerary.endTime && Array.isArray(itinerary.legs) && itinerary.legs.length > 0)
    .map((itinerary) => ({
      startTime: new Date(itinerary.startTime as string),
      endTime: new Date(itinerary.endTime as string),
      legs: (itinerary.legs as RawLeg[]).map((leg) => ({
        mode: leg.mode ?? "WALK",
        from: toPlace(leg.from),
        to: toPlace(leg.to),
        line: leg.displayName || leg.routeShortName || null,
      })),
    }));
  parsed.sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
  return parsed[0] ?? null;
}

/** Transitous (MOTIS) journey planner. Sends only coordinates and a time. */
export function createTransitousPlanner(deps: { get?: HttpGet; schedule?: Schedule } = {}): TransitPlanner {
  const get: HttpGet = deps.get ?? ((url, config) => axios.get(url, config));
  const schedule = deps.schedule ?? createThrottle(1000);
  return {
    plan(from, to, departAt) {
      return schedule(async () => {
        let data: unknown;
        try {
          const response = await get(TRANSITOUS_PLAN_URL, {
            params: { fromPlace: `${from[1]},${from[0]}`, toPlace: `${to[1]},${to[0]}`, time: departAt.toISOString() },
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            timeout: 20_000,
          });
          data = response.data;
        } catch (error) {
          throw new TransitUnavailableError(`Transitous: ${error instanceof Error ? error.message : String(error)}`);
        }
        return parseTransitousPlan(data);
      });
    },
  };
}
