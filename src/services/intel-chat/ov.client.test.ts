import { beforeEach, describe, expect, test } from "bun:test";
import { fakeOvFetch, NS, OVAPI, PASSES, stopAreaBody, ovapiPass } from "../../test/ov-fixtures";
import { isoAmsterdam, loadNsStations, loadStopAreas, nsDepartures, nsJourney, ovapiJourneyStops, ovapiPasses, parseOvTime, resetOvCaches, type OvSession } from "./ov.client";

const NOW = new Date("2026-10-15T14:25:00+02:00");

function session(fetch: OvSession["fetch"], over: Partial<OvSession> = {}) {
  let spent = 0;
  const s: OvSession = { fetch, now: () => NOW, nsKey: "test-key", spend: () => ++spent <= 25, ...over };
  return { s, spent: () => spent };
}

beforeEach(resetOvCaches);

describe("OV times", () => {
  test("OVapi local times get the Amsterdam offset (summer and winter time)", () => {
    expect(isoAmsterdam(parseOvTime("2026-10-15T15:08:00")!)).toBe("2026-10-15T15:08:00+02:00");
    expect(isoAmsterdam(parseOvTime("2026-10-26T15:08:00")!)).toBe("2026-10-26T15:08:00+01:00");
  });

  test("NS offsets without a colon are read and written with one", () => {
    expect(parseOvTime("2026-10-15T13:58:00+0200")!.toISOString()).toBe("2026-10-15T11:58:00.000Z");
    expect(isoAmsterdam(parseOvTime("2026-10-15T13:58:00+0200")!)).toBe("2026-10-15T13:58:00+02:00");
    expect(isoAmsterdam(new Date("2026-10-15T11:58:00Z"))).toBe("2026-10-15T13:58:00+02:00");
  });

  test("garbage is null", () => {
    expect(parseOvTime("morgen")).toBeNull();
    expect(parseOvTime(null)).toBeNull();
  });
});

describe("OVapi", () => {
  test("stop areas: bogus positions outside the Netherlands are dropped; cached, with a timeout signal", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s, spent } = session(fetch);
    const areas = await loadStopAreas(s);
    expect(areas.map((area) => area.id).sort()).toEqual(["224", "GslDrp", "ZpBus", "dvtbus", "dvtdor"]);
    expect(areas.find((area) => area.id === "ZpBus")).toEqual({ id: "ZpBus", name: "Station", town: "Zutphen", latLng: { lat: 52.144203, lng: 6.1934443 }, source: "OVAPI" });
    await loadStopAreas(s);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${OVAPI}/stopareacode`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(spent()).toBe(1);
  });

  test("passes: one comma request for several stop areas, cached per stop area for 45 s", async () => {
    const { fetch, calls } = fakeOvFetch();
    let now = NOW;
    const { s } = session(fetch, { now: () => now });
    const passes = await ovapiPasses(s, ["ZpBus", "224"]);
    expect(calls.map((call) => call.url)).toEqual([`${OVAPI}/stopareacode/ZpBus,224`]);
    expect(passes).toHaveLength(4);
    const late = passes.find((pass) => pass.key === "NL_20261015_8083_1033_0")!;
    expect(late).toMatchObject({ stopAreaCode: "224", mode: "BUS", line: "83", destination: "Warnsveld", order: 1, name: "Station", town: "Zutphen" });
    expect(isoAmsterdam(late.plannedDep!)).toBe("2026-10-15T14:38:00+02:00");
    expect(isoAmsterdam(late.expectedDep!)).toBe("2026-10-15T14:40:00+02:00");
    // Only the missing stop area is asked
    await ovapiPasses(s, ["ZpBus", "GslDrp"]);
    expect(calls[1].url).toBe(`${OVAPI}/stopareacode/GslDrp`);
    now = new Date(NOW.getTime() + 60_000);
    await ovapiPasses(s, ["ZpBus"]);
    expect(calls).toHaveLength(3);
  });

  test("journey: [] (what OVapi answers now) is no stops; real stops are ordered", async () => {
    const key = "NL_20261015_8081_1035_0";
    const { fetch, calls } = fakeOvFetch({
      ovapiJourneys: {
        [key]: { [key]: { Stops: { "9": PASSES.GslDrp.GslDrp["41300120"].Passes[key], "1": ovapiPass({ JourneyNumber: 1035, ExpectedDepartureTime: "2026-10-15T14:38:00" }) } } },
      },
    });
    const { s } = session(fetch);
    expect((await ovapiJourneyStops(s, key)).map((stop) => [stop.order, stop.town])).toEqual([
      [1, "Zutphen"],
      [9, "Gorssel"],
    ]);
    expect(await ovapiJourneyStops(s, "NL_20261015_8083_1033_0")).toEqual([]);
    // After an empty answer OVapi's /journey is skipped for a while
    expect(await ovapiJourneyStops(s, "NL_20261015_8083_1035_0")).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test("journey: HTTP 404 (what OVapi answers for unknown journeys, live 2026-10-15) is no stops too", async () => {
    const { calls } = fakeOvFetch();
    const notFound = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("Not found", { status: 404 });
    };
    const { s } = session(notFound);
    expect(await ovapiJourneyStops(s, "NL_20261015_8083_1033_0")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("HTTP errors and unreachable are Dutch errors", async () => {
    const { s } = session(fakeOvFetch({ status: 503 }).fetch);
    await expect(loadStopAreas(s)).rejects.toThrow("OVapi gaf HTTP 503");
    const { s: down } = session(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(ovapiPasses(down, ["ZpBus"])).rejects.toThrow("OVapi niet bereikbaar");
  });

  test("every real request is counted; over budget nothing is fetched", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s } = session(fetch, { spend: () => false });
    await expect(loadStopAreas(s)).rejects.toThrow("Limiet voor deze vraag bereikt");
    expect(calls).toHaveLength(0);
  });

  test("a pass without position falls back to its stop", async () => {
    const body = stopAreaBody("ZpBus", "41640171", { K_1: ovapiPass({ Latitude: undefined, Longitude: undefined }) });
    const { s } = session(fakeOvFetch({ passes: { ZpBus: body } }).fetch);
    expect((await ovapiPasses(s, ["ZpBus"]))[0].latLng).toEqual({ lat: 52.144203, lng: 6.1934443 });
  });
});

describe("NS", () => {
  test("stations: NL only, id NS:<code>, with the key header; cached", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s } = session(fetch);
    const stations = await loadNsStations(s);
    expect(stations.map((station) => station.id)).toEqual(["NS:ZP", "NS:LC", "NS:DV"]);
    expect(stations[0]).toEqual({ id: "NS:ZP", name: "Zutphen", town: null, latLng: { lat: 52.1452789306641, lng: 6.19416666030884 }, source: "NS", uic: "8400744", big: true });
    expect(stations[1].big).toBe(false);
    expect(new Headers(calls[0].init.headers).get("Ocp-Apim-Subscription-Key")).toBe("test-key");
    await loadNsStations(s);
    expect(calls).toHaveLength(1);
  });

  test("without a key nothing is asked", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s } = session(fetch, { nsKey: null });
    expect(await loadNsStations(s)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("departures from a time: normalised, delay from actual", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s } = session(fetch);
    const departures = await nsDepartures(s, "ZP", new Date("2026-10-15T14:00:00+02:00"));
    expect(calls[0].url).toBe(`${NS}/departures?station=ZP&maxJourneys=40&dateTime=${encodeURIComponent("2026-10-15T14:00:00+02:00")}`);
    expect(departures[1]).toMatchObject({ train: "17838", line: "ST 17838", destination: "Apeldoorn", platform: "2b", cancelled: false, status: "ON_STATION", date: "2026-10-15" });
    expect(isoAmsterdam(departures[1].planned)).toBe("2026-10-15T14:36:00+02:00");
    expect(isoAmsterdam(departures[1].expected)).toBe("2026-10-15T14:39:00+02:00");
  });

  test("journey: stopping stops only, arrival and departure times, line and destination", async () => {
    const { fetch, calls } = fakeOvFetch();
    const { s } = session(fetch);
    const trip = await nsJourney(s, "31241", "2026-10-15");
    expect(calls[0].url).toBe(`${NS}/journey?train=31241&dateTime=2026-10-15`);
    expect(trip).toMatchObject({ mode: "TRAIN", line: "ST 31241", destination: "Oldenzaal", estimated: false, journeyId: "NS:31241:2026-10-15" });
    expect(trip.stops.map((stop) => stop.name)).toEqual(["Zutphen", "Lochem", "Goor", "Hengelo", "Oldenzaal"]);
    expect(trip.stops[0]).toMatchObject({ arr: null, key: "8400744", latLng: { lat: 52.1452789306641, lng: 6.19416666030884 } });
    expect(isoAmsterdam(trip.stops[2].arr!)).toBe("2026-10-15T14:29:00+02:00");
    expect(isoAmsterdam(trip.stops[2].dep!)).toBe("2026-10-15T14:30:00+02:00");
  });

  test("an unknown train is a Dutch error", async () => {
    const { s } = session(fakeOvFetch().fetch);
    await expect(nsJourney(s, "99999", "2026-10-15")).rejects.toThrow("NS-API gaf HTTP 404");
  });
});
