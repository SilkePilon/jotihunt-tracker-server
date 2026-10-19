process.env.TZ = "Europe/Amsterdam";
import { describe, expect, test } from "bun:test";
import { brandOf, openIntervals, toRestaurant, type OverpassElement } from "./fastfood.helpers";

const NOW = new Date("2026-10-19T12:00:00+02:00");

// Real elements from Overpass (2026-10-19), trimmed
const ARNHEM: OverpassElement = {
  type: "node",
  id: 1234,
  lat: 51.9818,
  lon: 5.9089,
  tags: {
    "addr:city": "Arnhem",
    "addr:housenumber": "36",
    "addr:postcode": "6811EW",
    "addr:street": "Rijnstraat",
    amenity: "fast_food",
    brand: "McDonald's",
    "brand:wikidata": "Q38076",
    "contact:website": "https://mcdonaldsrestaurant.nl/arnhem-rijnstraat",
    description: "McDonald's Arnhem Rijnstraat",
    drive_through: "no",
    name: "McDonald's",
    opening_hours: "Mo-We 08:30-22:00; Th 08:30-23:00; Fr,Sa 08:30-01:30; Su 09:00-22:00",
    phone: "+31 26 445 6234",
  },
};
const VEENENDAAL_WAY: OverpassElement = {
  type: "way",
  id: 99,
  center: { lat: 52.03, lon: 5.54 },
  tags: { "brand:wikidata": "Q177054", brand: "Burger King", description: "Burger King Veenendaal Rondweg West", "addr:city": "Veenendaal" },
};

describe("brandOf", () => {
  test("maps the three wikidata ids", () => {
    expect(brandOf({ "brand:wikidata": "Q38076" })).toBe("mcdonalds");
    expect(brandOf({ "brand:wikidata": "Q524757" })).toBe("kfc");
    expect(brandOf({ "brand:wikidata": "Q177054" })).toBe("burgerking");
  });
  test("anything else is undefined", () => {
    expect(brandOf({ "brand:wikidata": "Q1" })).toBeUndefined();
    expect(brandOf({})).toBeUndefined();
  });
});

describe("toRestaurant", () => {
  test("maps a node with all fields", () => {
    expect(toRestaurant(ARNHEM, NOW)).toEqual({
      osmId: "node/1234",
      brand: "mcdonalds",
      branch: "Arnhem Rijnstraat",
      location: { type: "Point", coordinates: [5.9089, 51.9818] },
      street: "Rijnstraat",
      houseNumber: "36",
      postcode: "6811EW",
      city: "Arnhem",
      phone: "+31 26 445 6234",
      website: "https://mcdonaldsrestaurant.nl/arnhem-rijnstraat",
      driveThrough: false,
      openingHours: "Mo-We 08:30-22:00; Th 08:30-23:00; Fr,Sa 08:30-01:30; Su 09:00-22:00",
      updatedAt: NOW,
    });
  });
  test("a way uses its center and leaves missing fields out", () => {
    const restaurant = toRestaurant(VEENENDAAL_WAY, NOW)!;
    expect(restaurant.osmId).toBe("way/99");
    expect(restaurant.location.coordinates).toEqual([5.54, 52.03]);
    expect(restaurant.branch).toBe("Veenendaal Rondweg West");
    expect(restaurant).not.toHaveProperty("phone");
    expect(restaurant).not.toHaveProperty("driveThrough");
    expect(restaurant).not.toHaveProperty("openingHours");
  });
  test("phone and website fall back to contact:* and url", () => {
    const element: OverpassElement = { ...ARNHEM, tags: { "brand:wikidata": "Q524757", "contact:phone": "+31 1", url: "http://kfc.nl/x" } };
    const restaurant = toRestaurant(element, NOW)!;
    expect(restaurant.phone).toBe("+31 1");
    expect(restaurant.website).toBe("http://kfc.nl/x");
  });
  test("branch tag wins over description; a description equal to the brand gives no branch", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, branch: "Centrum" } }, NOW)!.branch).toBe("Centrum");
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, description: "McDonald's" } }, NOW)!.branch).toBeUndefined();
  });
  test("a brand name only counts as prefix when a non-letter follows", () => {
    const kfc = (description: string) => toRestaurant({ ...ARNHEM, tags: { "brand:wikidata": "Q524757", description } }, NOW)!.branch;
    expect(kfc("KFCentrum")).toBe("KFCentrum");
    expect(kfc("KFC Utrecht Centraal")).toBe("Utrecht Centraal");
    expect(kfc("KFC-Utrecht")).toBe("-Utrecht");
  });
  test("a description longer than 60 characters is not a branch", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, description: "x".repeat(61) } }, NOW)!.branch).toBeUndefined();
  });
  test("drive_through yes is true", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { ...ARNHEM.tags, drive_through: "yes" } }, NOW)!.driveThrough).toBe(true);
  });
  test("unknown brand or no coordinates is undefined", () => {
    expect(toRestaurant({ ...ARNHEM, tags: { "brand:wikidata": "Q1" } }, NOW)).toBeUndefined();
    expect(toRestaurant({ type: "node", id: 1, tags: ARNHEM.tags }, NOW)).toBeUndefined();
  });
});

const iso = (intervals: { start: Date; end: Date }[] | undefined) => intervals?.map(({ start, end }) => [start.toISOString(), end.toISOString()]);
const SATURDAY = new Date("2026-10-17T00:00:00+02:00");

describe("openIntervals", () => {
  test("an interval past midnight is one interval", () => {
    expect(iso(openIntervals("Mo-Su 10:00-01:00", SATURDAY, 2))).toEqual([
      ["2026-10-16T22:00:00.000Z", "2026-10-16T23:00:00.000Z"],
      ["2026-10-17T08:00:00.000Z", "2026-10-17T23:00:00.000Z"],
      ["2026-10-18T08:00:00.000Z", "2026-10-18T22:00:00.000Z"],
    ]);
  });
  test("24/7 is one interval over the whole window", () => {
    expect(iso(openIntervals("24/7", SATURDAY, 8))).toEqual([["2026-10-16T22:00:00.000Z", "2026-10-24T22:00:00.000Z"]]);
  });
  test("closed all window is an empty list", () => {
    expect(openIntervals("off", SATURDAY, 8)).toEqual([]);
    expect(openIntervals("Mo-Fr 10:00-22:00", SATURDAY, 2)).toEqual([]);
  });
  test("follows the end of summer time", () => {
    expect(iso(openIntervals("Mo-Su 10:00-22:00", new Date("2026-10-24T00:00:00+02:00"), 2))).toEqual([
      ["2026-10-24T08:00:00.000Z", "2026-10-24T20:00:00.000Z"],
      ["2026-10-25T09:00:00.000Z", "2026-10-25T21:00:00.000Z"],
    ]);
  });
  test("missing, invalid or only unknown hours are undefined", () => {
    expect(openIntervals(undefined, SATURDAY)).toBeUndefined();
    expect(openIntervals("blah", SATURDAY)).toBeUndefined();
    expect(openIntervals("Mo-Su 10:00-22:00 unknown", SATURDAY, 2)).toBeUndefined();
  });
  test("back-to-back intervals with different comments are one interval", () => {
    const mcdrive = '10:00-21:00 open "Restaurant" || Mo-Th 10:00-24:00; Fr,Sa 10:00-01:00; Su 10:00-24:00 open "McDrive"';
    expect(iso(openIntervals(mcdrive, new Date("2026-10-19T00:00:00+02:00"), 1))).toEqual([["2026-10-19T08:00:00.000Z", "2026-10-19T22:00:00.000Z"]]);
  });
  test("an interval ending at 24:00 and one starting at 00:00 the next day are one interval", () => {
    expect(iso(openIntervals('Mo 18:00-24:00 open "a"; Tu 00:00-02:00 open "b"', new Date("2026-10-19T00:00:00+02:00"), 2))).toEqual([
      ["2026-10-19T16:00:00.000Z", "2026-10-20T00:00:00.000Z"],
    ]);
  });
  test("comments don't matter", () => {
    expect(openIntervals('Mo-Su 07:00-23:00 open "drive"', SATURDAY, 1)).toHaveLength(1);
  });
});
