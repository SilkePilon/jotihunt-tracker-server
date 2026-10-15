import { readCapped } from "../article-media";
import { insideNl, type LatLng } from "./geo";
import type { Trip, TripStop } from "./ov-trip";
import { BUDGET_EXHAUSTED, ToolInputError } from "./tools/context";

/** OVapi (KV78Turbo, no key, HTTP only): bus, tram, metro and boat stop areas and their current/upcoming passes */
export const OVAPI_BASE_URL = "http://v0.ovapi.nl";
/** NS Reisinformatie API v2 (header Ocp-Apim-Subscription-Key = NS_API_KEY): train stations, departures, journeys */
export const NS_BASE_URL = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2";
export const OV_TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const STOP_AREAS_TTL_MS = 6 * 60 * 60_000;
const NS_STATIONS_TTL_MS = 24 * 60 * 60_000;
/** Passes, departures and journeys are cached briefly to stay polite */
const LIVE_TTL_MS = 45_000;
/** OVapi's /journey answered [] or 404 (it does for every journey since 2026): skip it for this long */
const JOURNEY_EMPTY_SKIP_MS = 10 * 60_000;
/** Most entries the OV cache holds; the oldest go first */
export const OV_CACHE_MAX = 2000;
/** NS departures asked per request (maxJourneys) */
export const NS_MAX_JOURNEYS = 40;

export const OV_MODES = ["BUS", "TRAM", "METRO", "BOAT", "TRAIN"] as const;
export type OvMode = (typeof OV_MODES)[number];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One tool call's access to the OV sources: fetch, its abort signal, the clock, the NS key and the per-turn budget */
export interface OvSession {
  fetch: Fetch;
  signal?: AbortSignal;
  now: () => Date;
  /** null: no NS_API_KEY, train data is skipped */
  nsKey: string | null;
  /** Use one request of this turn's OV budget; false when it is used up */
  spend: () => boolean;
}

/** This turn's OV budget is used up (callers may stop gracefully) */
export class OvBudgetError extends ToolInputError {
  constructor() {
    super(BUDGET_EXHAUSTED);
    this.name = "OvBudgetError";
  }
}

// --- Times -------------------------------------------------------------------------------------------------------

const OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", timeZoneName: "longOffset" });
const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes Amsterdam is ahead of UTC at this instant (60 or 120) */
export function amsterdamOffsetMin(at: Date): number {
  const name = OFFSET_FORMAT.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

/** "2026-10-15T15:08:00+02:00" (Amsterdam time with its offset) */
export function isoAmsterdam(at: Date): string {
  const offset = amsterdamOffsetMin(at);
  const local = new Date(at.getTime() + offset * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "15:08" in Amsterdam time */
export const hhmm = (at: Date) => isoAmsterdam(at).slice(11, 16);

/** "YYYY-MM-DD" of the Amsterdam day */
export const amsterdamDate = (at: Date) => isoAmsterdam(at).slice(0, 10);

/** An ISO time with offset (also NS' "+0200" and "Z"), or a local Amsterdam time without one (OVapi) */
export function parseOvTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  // Date.UTC would roll "2026-02-30" or "25:00" over into another moment
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(asUtc)) return null;
  const zone = match[7];
  if (zone) {
    const zoneHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
    const zoneMinutes = zone === "Z" ? 0 : Number(zone.slice(-2));
    if (zoneHours > 14 || zoneMinutes > 59) return null;
    const offset = zone === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (zoneHours * 60 + zoneMinutes);
    return new Date(asUtc - offset * 60_000);
  }
  // Local Amsterdam: the offset of the guessed instant, checked once more around a DST switch
  const guess = asUtc - amsterdamOffsetMin(new Date(asUtc)) * 60_000;
  return new Date(asUtc - amsterdamOffsetMin(new Date(guess)) * 60_000);
}

// --- HTTP + caches -----------------------------------------------------------------------------------------------

const cache = new Map<string, { until: number; value: unknown }>();
/** Learned from passes: which modes call at an OVapi stop area */
const modesByArea = new Map<string, OvMode[]>();
let journeyEmptyUntil = 0;

/** Tests only */
export function resetOvCaches() {
  cache.clear();
  modesByArea.clear();
  journeyEmptyUntil = 0;
}

/** Tests only */
export const ovCacheSize = () => cache.size;

function cached<T>(s: OvSession, key: string): T | undefined {
  const hit = cache.get(key);
  return hit && hit.until > s.now().getTime() ? (hit.value as T) : undefined;
}

/** Cache a value; expired entries are dropped first and the oldest go when over OV_CACHE_MAX */
function store(s: OvSession, key: string, value: unknown, ttlMs: number) {
  const now = s.now().getTime();
  for (const [entryKey, entry] of cache) if (entry.until <= now) cache.delete(entryKey);
  cache.delete(key);
  cache.set(key, { until: now + ttlMs, value });
  for (const oldest of cache.keys()) {
    if (cache.size <= OV_CACHE_MAX) break;
    cache.delete(oldest);
  }
}

/** The JSON body; `missing` is returned for a 404 when given (OVapi answers 404 for journeys it does not know) */
async function getJson(s: OvSession, source: "OVapi" | "NS-API", url: string, missing?: unknown): Promise<unknown> {
  if (!s.spend()) throw new OvBudgetError();
  const timeout = AbortSignal.timeout(OV_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "jotihunt-tracker (Intel chat)" };
  if (source === "NS-API" && s.nsKey) headers["Ocp-Apim-Subscription-Key"] = s.nsKey;
  let response: Response;
  try {
    response = await s.fetch(url, { headers, signal: s.signal ? AbortSignal.any([s.signal, timeout]) : timeout });
  } catch {
    throw new ToolInputError(`${source} niet bereikbaar`);
  }
  if (response.status === 404 && missing !== undefined) return missing;
  if (!response.ok) throw new ToolInputError(`${source} gaf HTTP ${response.status}`);
  const bytes = await readCapped(response, MAX_BYTES).catch(() => {
    throw new ToolInputError(`${source} niet bereikbaar`);
  });
  if (!bytes) throw new ToolInputError(`${source} gaf te veel gegevens`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ToolInputError(`${source} gaf geen geldig antwoord`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);
const latLngOf = (lat: unknown, lng: unknown): LatLng | null => {
  const point = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) && insideNl(point) ? point : null;
};
const modeOf = (value: unknown): OvMode => ((OV_MODES as readonly string[]).includes(String(value)) ? (value as OvMode) : "BUS");

// --- Stops -------------------------------------------------------------------------------------------------------

/** A bus/tram stop area (id = StopAreaCode) or a train station (id = "NS:<code>") */
export interface OvStopInfo {
  id: string;
  name: string;
  town: string | null;
  latLng: LatLng;
  source: "OVAPI" | "NS";
  /** NS: UIC code (matches journey stops) */
  uic?: string;
  /** NS: an intercity hub or larger */
  big?: boolean;
}

/** Every OVapi stop area with a position inside the Netherlands (cached 6 h) */
export async function loadStopAreas(s: OvSession): Promise<OvStopInfo[]> {
  const key = "ovapi:stopareas";
  const hit = cached<OvStopInfo[]>(s, key);
  if (hit) return hit;
  const body = await getJson(s, "OVapi", `${OVAPI_BASE_URL}/stopareacode`);
  const areas: OvStopInfo[] = [];
  for (const [code, value] of Object.entries(isObject(body) ? body : {})) {
    if (!isObject(value)) continue;
    const latLng = latLngOf(value.Latitude, value.Longitude);
    const name = text(value.TimingPointName);
    if (latLng && name) areas.push({ id: code, name, town: text(value.TimingPointTown), latLng, source: "OVAPI" });
  }
  store(s, key, areas, STOP_AREAS_TTL_MS);
  return areas;
}

const BIG_STATION = /^(MEGA|KNOOPPUNT_INTERCITY|INTERCITY|KNOOPPUNT_SNELTREIN)_STATION$/;

/** Dutch train stations (cached 24 h); [] without NS_API_KEY */
export async function loadNsStations(s: OvSession): Promise<OvStopInfo[]> {
  if (!s.nsKey) return [];
  const key = "ns:stations";
  const hit = cached<OvStopInfo[]>(s, key);
  if (hit) return hit;
  const body = await getJson(s, "NS-API", `${NS_BASE_URL}/stations`);
  const list = isObject(body) && Array.isArray(body.payload) ? body.payload : [];
  const stations = list.flatMap((station: unknown): OvStopInfo[] => {
    if (!isObject(station) || station.land !== "NL") return [];
    const latLng = latLngOf(station.lat, station.lng);
    const code = text(station.code);
    const name = isObject(station.namen) ? text(station.namen.lang) : null;
    return latLng && code && name ? [{ id: `NS:${code}`, name, town: null, latLng, source: "NS", uic: text(station.UICCode) ?? undefined, big: BIG_STATION.test(String(station.stationType)) }] : [];
  });
  store(s, key, stations, NS_STATIONS_TTL_MS);
  return stations;
}

/** Modes seen at an OVapi stop area (from passes fetched earlier); undefined when not known */
export const knownModes = (code: string): OvMode[] | undefined => modesByArea.get(code);

// --- OVapi passes ------------------------------------------------------------------------------------------------

/** One vehicle passing one stop (OVapi pass), normalised */
export interface OvPass {
  /** Journey key: DataOwnerCode_LocalServiceLevelCode_LinePlanningNumber_JourneyNumber_FortifyOrderNumber */
  key: string;
  stopAreaCode: string;
  mode: OvMode;
  line: string;
  destination: string;
  plannedArr: Date | null;
  expectedArr: Date | null;
  plannedDep: Date | null;
  expectedDep: Date | null;
  /** TripStopStatus: PLANNED, DRIVING, ARRIVED, PASSED, CANCEL, UNKNOWN… */
  status: string;
  /** UserStopOrderNumber: position of this stop in the journey */
  order: number;
  /** FIRST, INTERMEDIATE, LAST */
  stopType: string;
  name: string;
  town: string | null;
  latLng: LatLng | null;
}

function toPass(key: string, pass: Record<string, unknown>, stop?: Record<string, unknown>): OvPass {
  return {
    key,
    stopAreaCode: text(pass.StopAreaCode) ?? text(stop?.StopAreaCode) ?? "",
    mode: modeOf(pass.TransportType),
    line: text(pass.LinePublicNumber) ?? text(pass.LinePlanningNumber) ?? "?",
    destination: text(pass.DestinationName50) ?? "onbekend",
    plannedArr: parseOvTime(pass.TargetArrivalTime),
    expectedArr: parseOvTime(pass.ExpectedArrivalTime) ?? parseOvTime(pass.TargetArrivalTime),
    plannedDep: parseOvTime(pass.TargetDepartureTime),
    expectedDep: parseOvTime(pass.ExpectedDepartureTime) ?? parseOvTime(pass.TargetDepartureTime),
    status: text(pass.TripStopStatus) ?? "UNKNOWN",
    order: Number(pass.UserStopOrderNumber) || 0,
    stopType: text(pass.JourneyStopType) ?? "INTERMEDIATE",
    name: text(pass.TimingPointName) ?? text(stop?.TimingPointName) ?? "?",
    town: text(pass.TimingPointTown) ?? text(stop?.TimingPointTown),
    latLng: latLngOf(pass.Latitude ?? pass.latitude, pass.Longitude ?? pass.longitude) ?? latLngOf(stop?.Latitude, stop?.Longitude),
  };
}

/** Current and upcoming passes at these stop areas: one comma request for the ones not cached (45 s per stop area) */
export async function ovapiPasses(s: OvSession, codes: string[]): Promise<OvPass[]> {
  const unique = [...new Set(codes)];
  const missing = unique.filter((code) => cached(s, `ovapi:passes:${code}`) === undefined);
  if (missing.length > 0) {
    const body = await getJson(s, "OVapi", `${OVAPI_BASE_URL}/stopareacode/${missing.map(encodeURIComponent).join(",")}`);
    const byCode = new Map<string, OvPass[]>(missing.map((code) => [code, []]));
    for (const [code, timingPoints] of Object.entries(isObject(body) ? body : {})) {
      if (!isObject(timingPoints)) continue;
      const passes = byCode.get(code) ?? [];
      for (const timingPoint of Object.values(timingPoints)) {
        if (!isObject(timingPoint) || !isObject(timingPoint.Passes)) continue;
        const stop = isObject(timingPoint.Stop) ? timingPoint.Stop : undefined;
        for (const [key, pass] of Object.entries(timingPoint.Passes)) if (isObject(pass)) passes.push({ ...toPass(key, pass, stop), stopAreaCode: code });
      }
      byCode.set(code, passes);
    }
    for (const [code, passes] of byCode) {
      store(s, `ovapi:passes:${code}`, passes, LIVE_TTL_MS);
      if (passes.length > 0) modesByArea.set(code, [...new Set(passes.map((pass) => pass.mode))]);
    }
  }
  return unique.flatMap((code) => cached<OvPass[]>(s, `ovapi:passes:${code}`) ?? []);
}

/** The stops of an OVapi journey in order; [] when OVapi has none (its /journey answers [] or 404 for every journey since 2026) */
export async function ovapiJourneyStops(s: OvSession, key: string): Promise<OvPass[]> {
  const cacheKey = `ovapi:journey:${key}`;
  const hit = cached<OvPass[]>(s, cacheKey);
  if (hit) return hit;
  if (journeyEmptyUntil > s.now().getTime()) return [];
  const body = await getJson(s, "OVapi", `${OVAPI_BASE_URL}/journey/${encodeURIComponent(key)}`, []);
  const stops = isObject(body) && isObject(body[key]) && isObject(body[key].Stops) ? body[key].Stops : {};
  const passes = Object.values(stops)
    .filter(isObject)
    .map((pass) => toPass(key, pass))
    .sort((a, b) => a.order - b.order);
  if (passes.length === 0) journeyEmptyUntil = s.now().getTime() + JOURNEY_EMPTY_SKIP_MS;
  store(s, cacheKey, passes, LIVE_TTL_MS);
  return passes;
}

// --- NS ----------------------------------------------------------------------------------------------------------

export interface NsDeparture {
  train: string;
  /** "ST 31241" */
  line: string;
  destination: string;
  planned: Date;
  expected: Date;
  platform?: string;
  cancelled: boolean;
  status: string;
  /** Amsterdam operating day of the planned departure (journey id) */
  date: string;
}

/** Departures of a station from a time (default now), max NS_MAX_JOURNEYS (cached 45 s) */
export async function nsDepartures(s: OvSession, code: string, from?: Date): Promise<NsDeparture[]> {
  if (!s.nsKey) return [];
  const url = `${NS_BASE_URL}/departures?station=${encodeURIComponent(code)}&maxJourneys=${NS_MAX_JOURNEYS}${from ? `&dateTime=${encodeURIComponent(isoAmsterdam(from))}` : ""}`;
  const hit = cached<NsDeparture[]>(s, url);
  if (hit) return hit;
  const body = await getJson(s, "NS-API", url);
  const list = isObject(body) && isObject(body.payload) && Array.isArray(body.payload.departures) ? body.payload.departures : [];
  const departures = list.flatMap((departure: unknown): NsDeparture[] => {
    if (!isObject(departure)) return [];
    const product = isObject(departure.product) ? departure.product : {};
    const train = text(product.number);
    const planned = parseOvTime(departure.plannedDateTime);
    if (!train || !planned) return [];
    const platform = text(departure.actualTrack) ?? text(departure.plannedTrack);
    return [
      {
        train,
        line: `${text(product.categoryCode) ?? text(departure.trainCategory) ?? "trein"} ${train}`,
        destination: text(departure.direction) ?? "onbekend",
        planned,
        expected: parseOvTime(departure.actualDateTime) ?? planned,
        ...(platform ? { platform } : {}),
        cancelled: departure.cancelled === true,
        status: departure.cancelled === true ? "CANCEL" : (text(departure.departureStatus) ?? "UNKNOWN"),
        date: amsterdamDate(planned),
      },
    ];
  });
  store(s, url, departures, LIVE_TTL_MS);
  return departures;
}

/** A train's run on a day: the stops it calls at, with times and positions (cached 45 s) */
export async function nsJourney(s: OvSession, train: string, date: string): Promise<Trip> {
  if (!s.nsKey) throw new ToolInputError("Geen NS_API_KEY ingesteld: treinritten zijn niet beschikbaar");
  const url = `${NS_BASE_URL}/journey?train=${encodeURIComponent(train)}&dateTime=${encodeURIComponent(date)}`;
  const hit = cached<Trip>(s, url);
  if (hit) return hit;
  const body = await getJson(s, "NS-API", url);
  const list = isObject(body) && isObject(body.payload) && Array.isArray(body.payload.stops) ? body.payload.stops : [];
  let line = `trein ${train}`;
  let destination: string | null = null;
  const stops: TripStop[] = list.flatMap((entry: unknown): TripStop[] => {
    if (!isObject(entry) || !isObject(entry.stop) || entry.status === "PASSING") return [];
    const arrival = Array.isArray(entry.arrivals) && isObject(entry.arrivals[0]) ? entry.arrivals[0] : null;
    const departure = Array.isArray(entry.departures) && isObject(entry.departures[0]) ? entry.departures[0] : null;
    if (!arrival && !departure) return [];
    const product = isObject(departure?.product) ? departure.product : isObject(arrival?.product) ? arrival.product : null;
    if (product && text(product.categoryCode)) line = `${text(product.categoryCode)} ${train}`;
    const goal = isObject(departure?.destination) ? departure.destination : isObject(arrival?.destination) ? arrival.destination : null;
    if (goal && text(goal.name)) destination = text(goal.name);
    return [
      {
        name: text(entry.stop.name) ?? "?",
        town: null,
        latLng: latLngOf(entry.stop.lat, entry.stop.lng),
        plannedArr: parseOvTime(arrival?.plannedTime),
        arr: parseOvTime(arrival?.actualTime) ?? parseOvTime(arrival?.plannedTime),
        plannedDep: parseOvTime(departure?.plannedTime),
        dep: parseOvTime(departure?.actualTime) ?? parseOvTime(departure?.plannedTime),
        cancelled: departure?.cancelled === true || (!departure && arrival?.cancelled === true),
        key: text(entry.stop.uicCode) ?? undefined,
      },
    ];
  });
  if (stops.length === 0) throw new ToolInputError(`Geen rit gevonden voor trein ${train} op ${date}`);
  const trip: Trip = { mode: "TRAIN", line, destination: destination ?? stops[stops.length - 1].name, stops, estimated: false, journeyId: `NS:${train}:${date}` };
  store(s, url, trip, LIVE_TTL_MS);
  return trip;
}
