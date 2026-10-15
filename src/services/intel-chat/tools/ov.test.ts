import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Team } from "../../../models/team.model";
import { formatRdAnswer } from "../../rd-answer";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { fakeOvFetch, NS, nsDeparture, OVAPI, ovapiPass, STOP_AREAS, type OvFakeData } from "../../../test/ov-fixtures";
import { runTool } from "../../../test/tools";
import { resetOvCaches } from "../ov.client";
import { createTurnBudget, type IntelToolContext, type TurnBudget } from "./context";
import { ovTools } from "./ov";

const NOW = new Date("2026-10-15T14:25:00+02:00");
const ZUTPHEN_STATION = "52.144203, 6.1934443";
const WARNSVELD = { lat: 52.1376, lng: 6.2275 };

function team(apiId: number, name: string, area: string, lat: number, lng: number) {
  return { apiId, name, accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area, location: { type: "Point" as const, coordinates: [lng, lat] } };
}

function setup(data: OvFakeData = {}, extra: Partial<IntelToolContext> = {}) {
  const fake = fakeOvFetch({ places: { gorssel: { lat: 52.2005, lng: 6.2003 }, warnsveld: WARNSVELD }, ...data });
  const budget: TurnBudget = createTurnBudget();
  const tools = ovTools({ articleId: 1, now: () => NOW, toolModel: mockModel(() => ""), budget, fetch: fake.fetch, nsApiKey: "test-key", ...extra });
  const ovCalls = () => fake.calls.filter((call) => call.url.startsWith(OVAPI) || call.url.startsWith(NS));
  return { tools, calls: fake.calls, ovCalls, budget };
}

beforeAll(connectTestDb);
beforeEach(async () => {
  resetOvCaches();
  await clearTestDb();
  // Oscar around Zutphen - Vorden - Lochem, Alpha around Arnhem
  await Team.create([
    team(1, "Z1", "Oscar", 52.14, 6.2),
    team(2, "V1", "Oscar", 52.105, 6.31),
    team(3, "L1", "Oscar", 52.16, 6.42),
    team(4, "A1", "Alpha", 51.98, 5.9),
    team(5, "A2", "Alpha", 51.99, 5.95),
    team(6, "A3", "Alpha", 51.96, 5.92),
  ]);
});
afterAll(disconnectTestDb);

type Stop = { id: string; name: string; town: string | null; latLng: { lat: number; lng: number }; rdText: string; distanceM: number; modes: string[] };

describe("ovStopsNear", () => {
  test("bus stop areas and train stations near a point, nearest first, with modes", async () => {
    const { tools, ovCalls } = setup();
    const result = (await runTool(tools.ovStopsNear, { near: ZUTPHEN_STATION })) as { stops: Stop[]; note?: string };
    expect(result.note).toBeUndefined();
    expect(result.stops.map((stop) => [stop.id, stop.modes])).toEqual([
      ["ZpBus", ["BUS"]],
      ["224", ["BUS"]],
      ["NS:ZP", ["TRAIN"]],
    ]);
    expect(result.stops[0]).toEqual({ id: "ZpBus", name: "Station", town: "Zutphen", latLng: { lat: 52.144203, lng: 6.193444 }, rdText: formatRdAnswer(6.1934443, 52.144203), distanceM: 0, modes: ["BUS"] });
    expect(result.stops[2].distanceM).toBeGreaterThan(100);
    expect(ovCalls().map((call) => call.url)).toEqual([`${OVAPI}/stopareacode`, `${NS}/stations`, `${OVAPI}/stopareacode/ZpBus,224`]);
  });

  test("a place name is looked up with PDOK; the radius is at most 5 km", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.ovStopsNear, { near: "Gorssel", radiusM: 50_000 })) as { stops: Stop[] };
    expect(result.stops[0]).toMatchObject({ id: "GslDrp", distanceM: 0 });
    expect(result.stops.every((stop) => stop.distanceM <= 5000)).toBe(true);
    expect(result.stops.map((stop) => stop.id)).not.toContain("ZpBus");
  });

  test("without NS_API_KEY: no train stations, a note, NS never asked", async () => {
    const { tools, calls } = setup({}, { nsApiKey: "" });
    const result = (await runTool(tools.ovStopsNear, { near: ZUTPHEN_STATION })) as { stops: Stop[]; note: string };
    expect(result.stops.map((stop) => stop.id)).toEqual(["ZpBus", "224"]);
    expect(result.note).toContain("NS_API_KEY");
    expect(calls.some((call) => call.url.startsWith(NS))).toBe(false);
  });

  test("an unknown place is an error", async () => {
    const { tools } = setup();
    expect(await runTool(tools.ovStopsNear, { near: "Nergenshuizen" })).toEqual({ error: 'Plaats "Nergenshuizen" niet gevonden' });
  });

  test("OVapi down is a Dutch error", async () => {
    const { tools } = setup({ status: 503 });
    expect(await runTool(tools.ovStopsNear, { near: ZUTPHEN_STATION })).toEqual({ error: "OVapi gaf HTTP 503" });
  });

  test("modes that could not be learned (budget) are noted", async () => {
    const { tools, budget } = setup();
    budget.ov = 23;
    const result = (await runTool(tools.ovStopsNear, { near: ZUTPHEN_STATION })) as { stops: Stop[]; note: string };
    expect(result.stops.map((stop) => [stop.id, stop.modes])).toEqual([
      ["ZpBus", []],
      ["224", []],
      ["NS:ZP", ["TRAIN"]],
    ]);
    expect(result.note).toBe("Vervoerswijzen van bushaltes onbekend: limiet voor deze vraag bereikt");
  });

  test("modes that could not be learned (passes unavailable) are noted", async () => {
    const fake = fakeOvFetch();
    const fetch = async (url: string, init: RequestInit) => (url.startsWith(`${OVAPI}/stopareacode/`) ? new Response("nee", { status: 503 }) : fake.fetch(url, init));
    const { tools } = setup({}, { fetch });
    const result = (await runTool(tools.ovStopsNear, { near: ZUTPHEN_STATION })) as { stops: Stop[]; note: string };
    expect(result.stops[0].modes).toEqual([]);
    expect(result.note).toBe("Vervoerswijzen van bushaltes onbekend: OVapi gaf HTTP 503");
  });
});

type Departure = { mode: string; line: string; destination: string; planned: string; expected: string; delayMin: number; status: string; journeyId: string | null; platform?: string };

describe("ovDepartures", () => {
  test("a station: trains plus the bus stops beside it, by expected time within the window", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.ovDepartures, { stop: "NS:ZP", fromTime: "2026-10-15T14:00:00+02:00", windowMin: 60 })) as { stop: Stop; departures: Departure[]; note?: string };
    expect(result.stop).toMatchObject({ id: "NS:ZP", name: "Zutphen", modes: ["TRAIN"] });
    expect(result.departures.map((departure) => [departure.mode, departure.line, departure.destination, departure.expected, departure.delayMin])).toEqual([
      ["TRAIN", "ST 31241", "Oldenzaal", "2026-10-15T14:06:00+02:00", 0],
      ["BUS", "81", "Deventer", "2026-10-15T14:38:00+02:00", 0],
      ["TRAIN", "ST 17838", "Apeldoorn", "2026-10-15T14:39:00+02:00", 3],
      ["BUS", "83", "Warnsveld", "2026-10-15T14:40:00+02:00", 2],
    ]);
    expect(result.departures[0]).toMatchObject({ journeyId: "NS:31241:2026-10-15", platform: "2b", planned: "2026-10-15T14:06:00+02:00", status: "ON_STATION" });
    expect(result.departures[1]).toMatchObject({ journeyId: "OVAPI:NL_20261015_8081_1035_0@ZpBus", status: "PLANNED" });
    expect(result.departures[1]).not.toHaveProperty("platform");
    expect(result.note).toContain("OVapi");
  });

  test("a bus stop id, default window of 60 minutes from now", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.ovDepartures, { stop: "224" })) as { stop: Stop; departures: Departure[] };
    expect(result.stop.id).toBe("224");
    expect(result.departures.map((departure) => departure.expected)).toEqual([
      "2026-10-15T14:38:00+02:00",
      "2026-10-15T14:39:00+02:00",
      "2026-10-15T14:40:00+02:00",
      "2026-10-15T15:08:00+02:00",
      "2026-10-15T15:08:00+02:00",
    ]);
  });

  test("a point: the nearest stop", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.ovDepartures, { stop: "52.2006, 6.2004" })) as { stop: Stop; departures: Departure[] };
    expect(result.stop).toMatchObject({ id: "GslDrp", name: "Dorp", town: "Gorssel" });
    expect(result.stop.distanceM).toBeLessThan(50);
    expect(result.departures).toEqual([expect.objectContaining({ line: "81", expected: "2026-10-15T14:57:00+02:00", journeyId: "OVAPI:NL_20261015_8081_1035_0@GslDrp" })]);
  });

  test("NS gave its maximum of 40 departures ending before the window end: a note", async () => {
    const minute = (offset: number) => `14:${String(offset).padStart(2, "0")}`;
    const forty = { payload: { departures: Array.from({ length: 40 }, (_, index) => nsDeparture(String(30000 + index), "Oldenzaal", minute(index))) } };
    const { tools } = setup({ nsDepartures: { ZP: forty } });
    const result = (await runTool(tools.ovDepartures, { stop: "NS:ZP", fromTime: "2026-10-15T14:00:00+02:00", windowMin: 60 })) as { departures: Departure[]; note: string };
    expect(result.note).toContain("NS gaf maximaal 40 treinvertrekken (tot 14:39); latere treinen binnen het venster ontbreken");
    // Fewer than 40: the list is complete, no such note
    resetOvCaches();
    const { tools: few } = setup();
    const complete = (await runTool(few.ovDepartures, { stop: "NS:ZP", fromTime: "2026-10-15T14:00:00+02:00", windowMin: 60 })) as { note?: string };
    expect(complete.note ?? "").not.toContain("maximaal 40");
  });

  test("a garbage fromTime is a Dutch error", async () => {
    const { tools } = setup();
    const error = { error: "fromTime moet een tijd zijn (ISO 8601, bv. 2026-10-17T14:05:00+02:00)" };
    expect(await runTool(tools.ovDepartures, { stop: "NS:ZP", fromTime: "2026-10-15T25:00:00+02:00" })).toEqual(error);
    expect(await runTool(tools.ovDepartures, { stop: "NS:ZP", fromTime: "2026-02-31T14:00:00+02:00" })).toEqual(error);
  });

  test("a train station without NS_API_KEY is an error", async () => {
    const { tools } = setup({}, { nsApiKey: "" });
    expect(await runTool(tools.ovDepartures, { stop: "NS:ZP" })).toEqual({ error: "Geen NS_API_KEY ingesteld: treinvertrektijden zijn niet beschikbaar" });
  });
});

type JourneyResult = {
  mode: string;
  line: string;
  destination: string;
  stops: { name: string; town: string | null; latLng: unknown; planned: string | null; expected: string | null; status: string }[];
  current: { latLng: { lat: number; lng: number }; rdText: string; between: [string, string]; note: string } | null;
  note?: string;
};

describe("ovJourney", () => {
  test("a train: stops with status and the current position between two stations", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.ovJourney, { journeyId: "NS:31241:2026-10-15" })) as JourneyResult;
    expect(result).toMatchObject({ mode: "TRAIN", line: "ST 31241", destination: "Oldenzaal" });
    expect(result.stops.map((stop) => [stop.name, stop.status])).toEqual([
      ["Zutphen", "PASSED"],
      ["Lochem", "DEPARTED"],
      ["Goor", "DRIVING"],
      ["Hengelo", "PLANNED"],
      ["Oldenzaal", "PLANNED"],
    ]);
    expect(result.stops[2]).toMatchObject({ planned: "2026-10-15T14:30:00+02:00", expected: "2026-10-15T14:30:00+02:00" });
    expect(result.stops[4]).toMatchObject({ planned: "2026-10-15T14:57:00+02:00", expected: "2026-10-15T14:57:00+02:00" });
    expect(result.current).toMatchObject({ between: ["Lochem", "Goor"], note: "tussen Lochem en Goor, ~4 min tot Goor" });
    // Halfway (4 of 8 minutes)
    expect(result.current!.latLng.lng).toBeCloseTo((6.42638874053955 + 6.58444452285767) / 2, 2);
    expect(result.current!.rdText).toMatch(/^\d{4} \d{4}$/);
  });

  test("a bus (OVapi has no stop list): origin, known timing points and an estimated terminus", async () => {
    const { tools } = setup({}, { now: () => new Date("2026-10-15T14:45:00+02:00") });
    const result = (await runTool(tools.ovJourney, { journeyId: "OVAPI:NL_20261015_8081_1035_0@ZpBus" })) as JourneyResult;
    expect(result).toMatchObject({ mode: "BUS", line: "81", destination: "Deventer" });
    expect(result.stops.map((stop) => [stop.name, stop.town, stop.status])).toEqual([
      ["Station", "Zutphen", "DEPARTED"],
      ["Dorp", "Gorssel", "DRIVING"],
      ["Deventer, Station", "Deventer", "PLANNED"],
    ]);
    expect(result.stops[2].planned).toBeNull();
    expect(result.stops[2].expected).toMatch(/^2026-10-15T15:\d{2}:00\+02:00$/);
    expect(result.current).toMatchObject({ between: ["Station Zutphen", "Dorp Gorssel"], note: "tussen Station Zutphen en Dorp Gorssel, ~12 min tot Dorp Gorssel (geschat)" });
    expect(result.note).toContain("geschat");
  });

  test("journey ids of OVapi stop areas with spaces, '&' and '+' round-trip from ovDepartures", async () => {
    for (const code of ["Bd CS", "W&aAnj", "purp+r", "MttP&R"]) {
      resetOvCaches();
      const key = "NL_20261015_8081_1037_0";
      const zp = STOP_AREAS.ZpBus;
      const stop = { Longitude: zp.Longitude, Latitude: zp.Latitude, TimingPointTown: zp.TimingPointTown, TimingPointName: zp.TimingPointName, TimingPointCode: "1", StopAreaCode: code };
      const passes = { [code]: { [code]: { "1": { Stop: stop, Passes: { [key]: ovapiPass({ StopAreaCode: code }) } } } } };
      const { tools } = setup({ stopAreas: { [code]: { ...zp, StopAreaCode: code } }, passes });
      const departures = (await runTool(tools.ovDepartures, { stop: code })) as { departures: Departure[] };
      const journeyId = departures.departures.find((departure) => departure.mode === "BUS")!.journeyId!;
      expect(journeyId).toBe(`OVAPI:${key}@${code}`);
      const journey = (await runTool(tools.ovJourney, { journeyId })) as JourneyResult;
      expect(journey).toMatchObject({ mode: "BUS", line: "81", destination: "Deventer" });
      expect(journey.stops[0]).toMatchObject({ name: "Station", town: "Zutphen" });
    }
  });

  test("a bus journey still works when NS is down (destination lookup skips the stations)", async () => {
    const pass = ovapiPass({ DestinationName50: "Lochem", ExpectedDepartureTime: "2026-10-15T14:38:00", TargetDepartureTime: "2026-10-15T14:38:00" });
    const stop = { Longitude: 6.1934443, Latitude: 52.144203, TimingPointTown: "Zutphen", TimingPointName: "Station", TimingPointCode: "41640171", StopAreaCode: "ZpBus" };
    const fake = fakeOvFetch({ passes: { ZpBus: { ZpBus: { "41640171": { Stop: stop, Passes: { K_1: pass } } } } } });
    const fetch = async (url: string, init: RequestInit) => (url.startsWith(NS) ? new Response("nee", { status: 503 }) : fake.fetch(url, init));
    const { tools } = setup({}, { fetch });
    const result = (await runTool(tools.ovJourney, { journeyId: "OVAPI:K_1@ZpBus" })) as JourneyResult;
    expect(result).toMatchObject({ mode: "BUS", line: "81", destination: "Lochem" });
    expect(result.stops.map((stop) => stop.name)).toEqual(["Station"]);
  });

  test("unknown ids are errors", async () => {
    const { tools } = setup();
    expect(await runTool(tools.ovJourney, { journeyId: "bus 83" })).toEqual({ error: "Onbekende journeyId; gebruik er een uit ovDepartures of predictOvMovement" });
    expect(await runTool(tools.ovJourney, { journeyId: "OVAPI:NL_20261015_9999_1_0@ZpBus" })).toEqual({ error: "Deze rit staat niet (meer) bij OVapi; OVapi kent alleen actuele en komende ritten" });
  });
});

type Candidate = { point: { label: string; rdText: string; area: { area: string | null } }; via: string; kind: string; atTime: string; score: number; why: string; journeyId: string | null };
type Prediction = { candidates: Candidate[]; assumptions: string[]; note?: string };

describe("predictOvMovement", () => {
  test("seen at Zutphen station 25 min ago: on the train, on an earlier bus, at the terminus", async () => {
    const { tools, ovCalls, budget } = setup();
    const result = (await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00" })) as Prediction;
    expect(result.candidates.length).toBeGreaterThan(3);
    expect(result.candidates.length).toBeLessThanOrEqual(10);
    const scores = result.candidates.map((candidate) => candidate.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((score) => score >= 0 && score <= 1)).toBe(true);

    const train = result.candidates.find((candidate) => candidate.kind === "onboard" && candidate.journeyId === "NS:31241:2026-10-15")!;
    expect(train.via).toBe("trein ST 31241 → Oldenzaal (vertrek 14:06, Zutphen)");
    expect(train.atTime).toBe("2026-10-15T14:25:00+02:00");
    expect(train.why).toContain("tussen Lochem en Goor");
    expect(train.point.rdText).toMatch(/^\d{4} \d{4}$/);

    const bus81 = result.candidates.find((candidate) => candidate.kind === "onboard" && candidate.via.startsWith("bus 81"))!;
    expect(bus81.via).toBe("bus 81 → Deventer (vertrek 14:08, Station Zutphen)");
    expect(bus81.journeyId).toBeNull();
    expect(bus81.why).toContain("afgeleid");
    expect(bus81.why).toContain("tussen Station Zutphen en Dorp Gorssel");

    const warnsveld = result.candidates.find((candidate) => candidate.kind === "terminus" && candidate.via.startsWith("bus 83"))!;
    expect(warnsveld.point.label).toBe("Eindpunt Warnsveld");
    expect(warnsveld.point.area.area).toBe("oscar");

    expect(result.candidates.some((candidate) => candidate.kind === "alighted" && candidate.point.label === "Uitgestapt Lochem")).toBe(true);
    expect(result.assumptions.join(" ")).toContain("OVapi");
    expect(ovCalls().length).toBeLessThanOrEqual(25);
    expect(budget.ov).toBe(ovCalls().length);
  });

  test("the given area lifts candidates inside it", async () => {
    const scoreOf = async (area: string) => {
      resetOvCaches();
      const { tools } = setup();
      const result = (await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00", area })) as Prediction;
      return result.candidates.find((candidate) => candidate.point.label === "Eindpunt Warnsveld")!.score;
    };
    expect(await scoreOf("oscar")).toBeGreaterThan(await scoreOf("alpha"));
  });

  test("just seen: waiting at the stop for the next departure comes first", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:24:00+02:00", modes: ["BUS"] })) as Prediction;
    expect(result.candidates[0]).toMatchObject({ kind: "waiting", via: "bus 81 → Deventer (vertrek 14:38, Station Zutphen)", journeyId: "OVAPI:NL_20261015_8081_1035_0@ZpBus" });
    expect(result.candidates.every((candidate) => !candidate.via.startsWith("trein"))).toBe(true);
  });

  test("without NS_API_KEY only buses, with a note", async () => {
    const { tools, calls } = setup({}, { nsApiKey: "" });
    const result = (await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00" })) as Prediction;
    expect(result.note).toContain("NS_API_KEY");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.via.startsWith("bus"))).toBe(true);
    expect(calls.some((call) => call.url.startsWith(NS))).toBe(false);
  });

  test("no stop within walking distance", async () => {
    const { tools } = setup();
    const result = (await runTool(tools.predictOvMovement, { from: "52.30, 6.50", seenAt: "2026-10-15T14:00:00+02:00" })) as Prediction;
    expect(result.candidates).toEqual([]);
    expect(result.note).toBe("Geen halte of station binnen 800 m van het punt");
  });

  test("bad input", async () => {
    const { tools } = setup();
    expect(await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "gisteren" })).toEqual({ error: "seenAt moet een tijd zijn (ISO 8601, bv. 2026-10-17T14:05:00+02:00)" });
    expect(await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T13:75:00+02:00" })).toEqual({ error: "seenAt moet een tijd zijn (ISO 8601, bv. 2026-10-17T14:05:00+02:00)" });
    expect(await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T15:00:00+02:00" })).toEqual({ error: "seenAt ligt in de toekomst" });
    expect(await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00", modes: ["FIETS"] })).toEqual({ error: "Onbekende vervoerswijze: FIETS" });
  });

  test("over this turn's OV budget nothing is fetched", async () => {
    const { tools, ovCalls, budget } = setup();
    budget.ov = 25;
    expect(await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00" })).toEqual({ error: "Limiet voor deze vraag bereikt" });
    expect(ovCalls()).toHaveLength(0);
  });

  test("the budget running out halfway still gives the candidates found so far", async () => {
    const { tools, budget } = setup();
    budget.ov = 21;
    const result = (await runTool(tools.predictOvMovement, { from: ZUTPHEN_STATION, seenAt: "2026-10-15T14:00:00+02:00" })) as Prediction;
    expect(budget.ov).toBe(25);
    expect(result.assumptions.join(" ")).toContain("Limiet van 25 OV-verzoeken");
  });
});
