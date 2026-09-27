import { describe, expect, test } from "bun:test";
import type { TransitItinerary, TransitLeg, TransitPlace } from "./routing";
import { alightingStops, chooseTravel, isTransitMode, selectIslands, transitLabel, type IslandStop } from "./transit";

const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const place = (name: string, lng: number, arrival: Date | null = null): TransitPlace => ({ name, lng, lat: 52, arrival, departure: null });
const leg = (mode: string, to: TransitPlace, line: string | null = null): TransitLeg => ({ mode, from: place("x", 5), to, line });

function itinerary(legs: TransitLeg[], endMinutes: number): TransitItinerary {
  return { startTime: at(15), endTime: at(endMinutes), legs };
}

describe("isTransitMode", () => {
  test("oscar, orange status or a nearby stop", () => {
    expect(isTransitMode({ area: "oscar", status: "green", nearestStopDistanceM: Infinity })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "orange", nearestStopDistanceM: Infinity })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "green", nearestStopDistanceM: 249 })).toBe(true);
    expect(isTransitMode({ area: "alpha", status: "green", nearestStopDistanceM: 251 })).toBe(false);
  });
});

describe("transitLabel", () => {
  test("names the ridden lines in order", () => {
    const trip = itinerary(
      [leg("WALK", place("Kerk", 5.1)), leg("BUS", place("De Klomp", 5.2), "80"), leg("REGIONAL_RAIL", place("Utrecht Centraal", 5.3), "Intercity"), leg("WALK", place("END", 5.4))],
      100,
    );
    expect(transitLabel(trip)).toBe("bus 80 → trein Intercity");
  });

  test("null for walking-only itineraries", () => {
    expect(transitLabel(itinerary([leg("WALK", place("END", 5.4))], 60))).toBeNull();
  });
});

describe("chooseTravel", () => {
  const departAt = at(15);
  const bus = itinerary([leg("WALK", place("A", 5.1)), leg("BUS", place("B", 5.2, at(45)), "80"), leg("WALK", place("END", 5.3))], 55);

  test("transit when faster than walking", () => {
    expect(chooseTravel(60, bus, departAt)).toEqual({ travelMinutes: 40, via: "transit", transitLabel: "bus 80" });
  });

  test("walking when faster, when there is no itinerary or when it is walking-only", () => {
    expect(chooseTravel(30, bus, departAt)).toEqual({ travelMinutes: 30, via: "walk" });
    expect(chooseTravel(60, null, departAt)).toEqual({ travelMinutes: 60, via: "walk" });
    expect(chooseTravel(60, itinerary([leg("WALK", place("END", 5.4))], 40), departAt)).toEqual({ travelMinutes: 60, via: "walk" });
  });
});

describe("islands", () => {
  test("alighting stops are the destinations of ridden legs", () => {
    const trip = itinerary([leg("WALK", place("A", 5.1, at(20))), leg("BUS", place("B", 5.2, at(45)), "80"), leg("WALK", place("END", 5.3, at(55)))], 55);
    expect(alightingStops([trip])).toEqual([{ name: "B", lng: 5.2, lat: 52, arrival: at(45) }]);
  });

  test("reached stops only, largest remaining time first, deduplicated, at most 3", () => {
    const stops: IslandStop[] = [
      { name: "A", lng: 5.1, lat: 52, arrival: at(30) },
      { name: "B", lng: 5.2, lat: 52, arrival: at(50) },
      { name: "B again", lng: 5.2, lat: 52, arrival: at(40) },
      { name: "C", lng: 5.3, lat: 52, arrival: at(55) },
      { name: "D", lng: 5.4, lat: 52, arrival: at(58) },
      { name: "Future", lng: 5.5, lat: 52, arrival: at(80) },
    ];
    const islands = selectIslands(stops, at(60));
    expect(islands.map((island) => [island.stop.name, island.remainingMinutes])).toEqual([
      ["A", 30],
      ["B again", 20],
      ["C", 5],
    ]);
  });
});
