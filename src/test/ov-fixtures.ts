/**
 * Small real-shaped OVapi / NS Reisinformatie fixtures (recorded around Zutphen on 2026-10-15, trimmed) and a fake
 * fetch that serves them. Tests never call the live APIs.
 */

export const OVAPI = "http://v0.ovapi.nl";
export const NS = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2";
export const PDOK = "https://api.pdok.nl/";

/** OVapi `/stopareacode` (a few real entries; GtcBeu/WvdHor carry OVapi's bogus 47.97,3.31 position) */
export const STOP_AREAS = {
  ZpBus: { TimingPointTown: "Zutphen", TimingPointName: "Station", StopAreaCode: "ZpBus", Longitude: 6.1934443, Latitude: 52.144203 },
  "224": { TimingPointTown: "Zutphen", TimingPointName: "Station", StopAreaCode: "224", Longitude: 6.193693, Latitude: 52.144245 },
  GslDrp: { TimingPointTown: "Gorssel", TimingPointName: "Dorp", StopAreaCode: "GslDrp", Longitude: 6.2003, Latitude: 52.2005 },
  dvtbus: { TimingPointTown: "Deventer", TimingPointName: "Deventer, Station", StopAreaCode: "dvtbus", Longitude: 6.159013, Latitude: 52.257557 },
  dvtdor: { TimingPointTown: "Deventer", TimingPointName: "Deventer, Dortmundstraat", StopAreaCode: "dvtdor", Longitude: 6.1954346, Latitude: 52.2444 },
  GtcBeu: { TimingPointTown: "Guttecoven", TimingPointName: "Beukenboomsweg", StopAreaCode: "GtcBeu", Longitude: 3.3135424, Latitude: 47.974766 },
  WvdHor: { TimingPointTown: "Warnsveld", TimingPointName: "'t Horseler", StopAreaCode: "WvdHor", Longitude: 3.3135424, Latitude: 47.974766 },
};

/** One OVapi pass (the real 81 Zutphen → Deventer pass at Station Zutphen), with overrides */
export function ovapiPass(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IsTimingStop: true,
    DestinationName50: "Deventer",
    DataOwnerCode: "NL",
    OperatorCode: "RRREIS",
    FortifyOrderNumber: 0,
    TransportType: "BUS",
    Latitude: 52.144203,
    Longitude: 6.1934443,
    JourneyNumber: 1037,
    LocalServiceLevelCode: 20261015,
    LineDirection: 2,
    OperationDate: "2026-10-15",
    TimingPointCode: "41640171",
    LineName: "Zutphen - Deventer",
    LinePublicNumber: "81",
    DestinationCode: "P11551",
    ExpectedDepartureTime: "2026-10-15T15:08:00",
    UserStopOrderNumber: 1,
    TimingPointName: "Station",
    LinePlanningNumber: "8081",
    StopAreaCode: "ZpBus",
    TimingPointTown: "Zutphen",
    TripStopStatus: "PLANNED",
    JourneyStopType: "FIRST",
    TargetArrivalTime: "2026-10-15T15:08:00",
    TargetDepartureTime: "2026-10-15T15:08:00",
    ExpectedArrivalTime: "2026-10-15T15:08:00",
    ...over,
  };
}

/** OVapi `/stopareacode/{code}` body for one timing point */
export function stopAreaBody(code: string, tpc: string, passes: Record<string, Record<string, unknown>>) {
  const area = STOP_AREAS[code as keyof typeof STOP_AREAS];
  return { [code]: { [tpc]: { Stop: { Longitude: area.Longitude, Latitude: area.Latitude, TimingPointTown: area.TimingPointTown, TimingPointName: area.TimingPointName, TimingPointCode: tpc, StopAreaCode: code }, Passes: passes } } };
}

const at = (time: string) => ({ TargetDepartureTime: `2026-10-15T${time}`, ExpectedDepartureTime: `2026-10-15T${time}`, TargetArrivalTime: `2026-10-15T${time}`, ExpectedArrivalTime: `2026-10-15T${time}` });

/** Passes at 14:25: bus 81 → Deventer (ZpBus) at 14:38 and 15:08, bus 83 → Warnsveld (224) at 14:38 (2 min late) and 15:08, journey 1035 of the 81 at Gorssel 14:57 */
export const PASSES = {
  ZpBus: stopAreaBody("ZpBus", "41640171", {
    NL_20261015_8081_1035_0: ovapiPass({ JourneyNumber: 1035, ...at("14:38:00") }),
    NL_20261015_8081_1037_0: ovapiPass({ JourneyNumber: 1037, ...at("15:08:00") }),
  }),
  "224": stopAreaBody("224", "41640176", {
    NL_20261015_8083_1033_0: ovapiPass({
      JourneyNumber: 1033,
      LinePublicNumber: "83",
      LinePlanningNumber: "8083",
      DestinationName50: "Warnsveld",
      StopAreaCode: "224",
      TimingPointCode: "41640176",
      ...at("14:38:00"),
      ExpectedDepartureTime: "2026-10-15T14:40:00",
    }),
    NL_20261015_8083_1035_0: ovapiPass({ JourneyNumber: 1035, LinePublicNumber: "83", LinePlanningNumber: "8083", DestinationName50: "Warnsveld", StopAreaCode: "224", TimingPointCode: "41640176", ...at("15:08:00") }),
  }),
  GslDrp: stopAreaBody("GslDrp", "41300120", {
    NL_20261015_8081_1035_0: ovapiPass({ JourneyNumber: 1035, StopAreaCode: "GslDrp", TimingPointName: "Dorp", TimingPointTown: "Gorssel", UserStopOrderNumber: 9, JourneyStopType: "INTERMEDIATE", ...at("14:57:00") }),
  }),
};

/** NS `/stations` (trimmed; HAMH is German) */
export const NS_STATIONS = {
  payload: [
    { code: "ZP", UICCode: "8400744", namen: { lang: "Zutphen", middel: "Zutphen", kort: "Zutphen" }, lat: 52.1452789306641, lng: 6.19416666030884, land: "NL", stationType: "KNOOPPUNT_INTERCITY_STATION" },
    { code: "LC", UICCode: "8400399", namen: { lang: "Lochem", middel: "Lochem", kort: "Lochem" }, lat: 52.1666679382324, lng: 6.42638874053955, land: "NL", stationType: "STOPTREIN_STATION" },
    { code: "DV", UICCode: "8400173", namen: { lang: "Deventer", middel: "Deventer", kort: "Deventer" }, lat: 52.2574996948242, lng: 6.16055536270142, land: "NL", stationType: "KNOOPPUNT_INTERCITY_STATION" },
    { code: "HAMH", UICCode: "8002549", namen: { lang: "Hamburg Hbf", middel: "Hamburg Hbf", kort: "Hamburg" }, lat: 53.5530014038086, lng: 10.0069999694824, land: "D", stationType: "MEGA_STATION" },
  ],
};

/** One NS departure (real shape: offsets without a colon) */
export function nsDeparture(number: string, direction: string, planned: string, actual = planned, over: Record<string, unknown> = {}) {
  return {
    direction,
    name: `RRReis A ${number}`,
    plannedDateTime: `2026-10-15T${planned}:00+0200`,
    plannedTimeZoneOffset: 120,
    actualDateTime: `2026-10-15T${actual}:00+0200`,
    actualTimeZoneOffset: 120,
    plannedTrack: "2b",
    actualTrack: "2b",
    product: { number, lineNumber: "RS24", categoryCode: "ST", shortCategoryName: "Blauwnet A Stoptrein", longCategoryName: "Stoptrein", type: "TRAIN" },
    trainCategory: "ST",
    cancelled: false,
    routeStations: [],
    messages: [],
    departureStatus: "ON_STATION",
    ...over,
  };
}

export const NS_DEPARTURES_ZP = { payload: { source: "PPV", departures: [nsDeparture("31241", "Oldenzaal", "14:06"), nsDeparture("17838", "Apeldoorn", "14:36", "14:39")] } };

const nsStop = (name: string, uicCode: string, lat: number, lng: number, status: string, arrival: string | null, departure: string | null) => {
  const event = (time: string) => ({
    product: { number: "31241", lineNumber: "RS24", categoryCode: "ST", shortCategoryName: "Stoptrein", type: "TRAIN" },
    destination: { name: "Oldenzaal", lat: 52.3063888549805, lng: 6.93472242355347, uicCode: "8400483" },
    plannedTime: `2026-10-15T${time}:00+0200`,
    actualTime: `2026-10-15T${time}:00+0200`,
    delayInSeconds: 0,
    plannedTrack: "2",
    cancelled: false,
  });
  return {
    id: `${uicCode}_0`,
    stop: { name, lng, lat, countryCode: "NL", uicCode },
    status,
    arrivals: arrival ? [event(arrival)] : [],
    departures: departure ? [event(departure)] : [],
  };
};

/** NS `/journey?train=31241` (Zutphen 14:06 → Oldenzaal 14:57; Hengelo Gezondheidspark passed without stopping) */
export const NS_JOURNEY_31241 = {
  payload: {
    notes: [],
    productNumbers: ["31241"],
    stops: [
      nsStop("Zutphen", "8400744", 52.1452789306641, 6.19416666030884, "ORIGIN", null, "14:06"),
      nsStop("Lochem", "8400399", 52.1666679382324, 6.42638874053955, "STOP", "14:21", "14:21"),
      nsStop("Goor", "8400254", 52.2302780151367, 6.58444452285767, "STOP", "14:29", "14:30"),
      { ...nsStop("Hengelo Gezondheidspark", "8400433", 52.261667, 6.767778, "PASSING", null, null) },
      nsStop("Hengelo", "8400316", 52.2616653442383, 6.79388904571533, "STOP", "14:44", "14:47"),
      nsStop("Oldenzaal", "8400483", 52.3063888549805, 6.93472242355347, "DESTINATION", "14:57", null),
    ],
  },
};

export interface OvFakeData {
  stopAreas?: unknown;
  passes?: Record<string, Record<string, unknown>>;
  ovapiJourneys?: Record<string, unknown>;
  nsStations?: unknown;
  nsDepartures?: Record<string, unknown>;
  nsJourneys?: Record<string, unknown>;
  /** PDOK free search: one hit per query text (lowercase) */
  places?: Record<string, { lat: number; lng: number }>;
  /** HTTP status for every OVapi / NS request */
  status?: number;
}

export type OvCall = { url: string; init: RequestInit };

/** A fake fetch serving the fixtures; records every call */
export function fakeOvFetch(data: OvFakeData = {}) {
  const calls: OvCall[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.startsWith(PDOK)) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
      const hit = data.places?.[q];
      return Response.json({ response: { docs: hit ? [{ weergavenaam: q, type: "woonplaats", centroide_ll: `POINT(${hit.lng} ${hit.lat})` }] : [] } });
    }
    if (data.status && data.status !== 200) return new Response("nee", { status: data.status });
    if (url === `${OVAPI}/stopareacode`) return Response.json(data.stopAreas ?? STOP_AREAS);
    if (url.startsWith(`${OVAPI}/stopareacode/`)) {
      const codes = decodeURIComponent(url.slice(`${OVAPI}/stopareacode/`.length)).split(",");
      const passes: Record<string, unknown> = data.passes ?? PASSES;
      return Response.json(Object.assign({}, ...codes.map((code) => passes[code] ?? {})));
    }
    if (url.startsWith(`${OVAPI}/journey/`)) return Response.json(data.ovapiJourneys?.[decodeURIComponent(url.slice(`${OVAPI}/journey/`.length))] ?? []);
    if (url === `${NS}/stations`) return Response.json(data.nsStations ?? NS_STATIONS);
    if (url.startsWith(`${NS}/departures`)) {
      const station = new URL(url).searchParams.get("station") ?? "";
      return Response.json((data.nsDepartures ?? { ZP: NS_DEPARTURES_ZP })[station] ?? { payload: { departures: [] } });
    }
    if (url.startsWith(`${NS}/journey`)) {
      const train = new URL(url).searchParams.get("train") ?? "";
      const journey = (data.nsJourneys ?? { "31241": NS_JOURNEY_31241 })[train];
      return journey ? Response.json(journey) : Response.json({ code: 404, errors: [{ message: "not found" }] }, { status: 404 });
    }
    return new Response("unknown", { status: 404 });
  };
  return { fetch, calls };
}
