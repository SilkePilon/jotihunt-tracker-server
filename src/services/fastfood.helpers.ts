import OpeningHours from "opening_hours";

/** The chains on the map, by their Wikidata id in OSM's `brand:wikidata` tag. */
export type Brand = "mcdonalds" | "kfc" | "burgerking";
const BRAND_WIKIDATA: Record<string, Brand> = { Q38076: "mcdonalds", Q524757: "kfc", Q177054: "burgerking" };
/** Brand names a `description` starts with ("McDonald's Arnhem Rijnstraat"), stripped to get the branch. */
const BRAND_NAMES: Record<Brand, string[]> = {
  mcdonalds: ["McDonald's", "McDonalds"],
  kfc: ["Kentucky Fried Chicken", "KFC"],
  burgerking: ["Burger King"],
};
const MAX_BRANCH_LENGTH = 60;

/** All three chains in the Netherlands; ways and relations come with a centre point. */
export const OVERPASS_QUERY = `[out:json][timeout:90];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
nwr["brand:wikidata"~"^(Q38076|Q524757|Q177054)$"](area.nl);
out center tags;`;

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface Restaurant {
  /** "node/123" */
  osmId: string;
  brand: Brand;
  /** e.g. "Arnhem Rijnstraat" */
  branch?: string;
  location: { type: "Point"; coordinates: [number, number] };
  street?: string;
  houseNumber?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  website?: string;
  driveThrough?: boolean;
  /** The raw OSM `opening_hours` value */
  openingHours?: string;
  updatedAt: Date;
}

export interface OpenInterval {
  start: Date;
  end: Date;
}

export function brandOf(tags: Record<string, string>): Brand | undefined {
  return BRAND_WIKIDATA[tags["brand:wikidata"] ?? ""];
}

function branchOf(tags: Record<string, string>, brand: Brand): string | undefined {
  if (tags.branch?.trim()) return tags.branch.trim();
  let text = tags.description?.trim() ?? "";
  // Only a whole brand name counts: "KFCentrum" keeps its "KFC"
  const prefix = BRAND_NAMES[brand].find((name) => text.toLowerCase().startsWith(name.toLowerCase()) && !/\p{L}/u.test(text.charAt(name.length)));
  if (prefix) text = text.slice(prefix.length).trim();
  return text && text.length <= MAX_BRANCH_LENGTH ? text : undefined;
}

function driveThroughOf(value: string | undefined): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** Drop undefined fields, so the stored documents and the API items only carry what OSM knows. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** One Overpass element as a restaurant; undefined for another brand or an element without a position. */
export function toRestaurant(element: OverpassElement, now: Date): Restaurant | undefined {
  const tags = element.tags ?? {};
  const brand = brandOf(tags);
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!brand || lat === undefined || lon === undefined) return undefined;
  return compact({
    osmId: `${element.type}/${element.id}`,
    brand,
    branch: branchOf(tags, brand),
    location: { type: "Point" as const, coordinates: [lon, lat] as [number, number] },
    street: tags["addr:street"],
    houseNumber: tags["addr:housenumber"],
    postcode: tags["addr:postcode"],
    city: tags["addr:city"],
    phone: tags.phone ?? tags["contact:phone"],
    website: tags.website ?? tags["contact:website"] ?? tags.url,
    driveThrough: driveThroughOf(tags.drive_through),
    openingHours: tags.opening_hours?.trim() || undefined,
    updatedAt: now,
  });
}

/** Public holidays (PH) and school holidays (SH) are Dutch ones */
const NOMINATIM = { lat: 52.1, lon: 5.3, address: { country_code: "nl", state: "Gelderland" } };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The times `openingHours` is open in the `days` days from `from` (in the server's time zone, Europe/Amsterdam).
 * An interval past midnight is one interval, and so are back-to-back intervals (the library splits where the comment
 * changes, e.g. "Restaurant" until 21:00 then "McDrive"); the last one is cut at the end of the window. Undefined when the hours
 * are missing, can't be parsed, or are only "unknown"; an empty list when closed the whole window.
 */
export function openIntervals(openingHours: string | undefined, from: Date, days = 8): OpenInterval[] | undefined {
  if (!openingHours) return undefined;
  let intervals: [Date, Date, boolean, string | undefined][];
  try {
    const hours = new OpeningHours(openingHours, NOMINATIM as never);
    intervals = hours.getOpenIntervals(from, new Date(from.getTime() + days * DAY_MS));
  } catch {
    return undefined;
  }
  // Unknown stretches mixed with known ones (e.g. "PH unknown") are dropped, so they read as closed
  const known = intervals.filter(([, , unknown]) => !unknown);
  if (intervals.length && !known.length) return undefined;
  const merged: OpenInterval[] = [];
  for (const [start, end] of known) {
    const previous = merged.at(-1);
    if (previous && start.getTime() <= previous.end.getTime()) {
      if (end.getTime() > previous.end.getTime()) previous.end = end;
    } else merged.push({ start, end });
  }
  return merged;
}
