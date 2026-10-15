import { describe, expect, test } from "bun:test";
import { mockModel } from "../../test/ai";
import { runTool } from "../../test/tools";
import { geocode, parseWktPoint, reverseGeocode } from "./pdok.client";
import { mapTools } from "./tools/map";

function fakeFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return Response.json(body, { status });
  };
  return { fetch, urls };
}

const FREE = {
  response: {
    docs: [
      { type: "adres", weergavenaam: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", centroide_ll: "POINT(5.87232125 51.95386777)" },
      { type: "weg", weergavenaam: "zonder punt" },
    ],
  },
};
const REVERSE = { response: { docs: [{ type: "adres", weergavenaam: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", afstand: 14.85 }] } };

describe("PDOK client", () => {
  test("geocode asks /free with the fields we need and skips docs without a point", async () => {
    const { fetch, urls } = fakeFetch(FREE);
    expect(await geocode("Stikkerstraat 10 Arnhem", { fetch })).toEqual([{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", latLng: { lat: 51.95386777, lng: 5.87232125 } }]);
    expect(urls[0]).toBe("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=Stikkerstraat%2010%20Arnhem&rows=10&fl=weergavenaam,type,centroide_ll,woonplaatsnaam,gemeentenaam");
  });

  test("results in a town named in the query come first, its addresses/streets before the town itself; at most 5", async () => {
    const doc = (weergavenaam: string, type: string, woonplaatsnaam: string, gemeentenaam: string) => ({ weergavenaam, type, woonplaatsnaam, gemeentenaam, centroide_ll: "POINT(6 52)" });
    const { fetch } = fakeFetch({
      response: {
        docs: [
          doc("Station, Vlodrop", "weg", "Vlodrop", "Roerdalen"),
          doc("Stationsweg, Beek", "weg", "Beek", "Montferland"),
          doc("Zutphen", "woonplaats", "Zutphen", "Zutphen"),
          doc("Stationsplein, Zutphen", "weg", "Zutphen", "Zutphen"),
          doc("Station, Venlo", "weg", "Venlo", "Venlo"),
          doc("Stationsstraat, Warnsveld", "weg", "Warnsveld", "Zutphen"),
          doc("Station, Lent", "weg", "Lent", "Nijmegen"),
        ],
      },
    });
    expect((await geocode("Station Zutphen", { fetch })).map((hit) => hit.name)).toEqual(["Stationsplein, Zutphen", "Stationsstraat, Warnsveld", "Zutphen", "Station, Vlodrop", "Stationsweg, Beek"]);
    // Only the town asked: PDOK's order (the town itself first)
    expect((await geocode("Zutphen", { fetch })).map((hit) => hit.name).slice(0, 3)).toEqual(["Zutphen", "Stationsplein, Zutphen", "Stationsstraat, Warnsveld"]);
    // No town in the query: PDOK's order
    expect((await geocode("Stationsweg", { fetch })).map((hit) => hit.name)[0]).toBe("Station, Vlodrop");
  });

  test("reverseGeocode asks /reverse and rounds the distance", async () => {
    const { fetch, urls } = fakeFetch(REVERSE);
    expect(await reverseGeocode({ lat: 51.95392, lng: 5.87252 }, { fetch })).toEqual([{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", distanceM: 15 }]);
    expect(urls[0]).toBe("https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse?lat=51.953920&lon=5.872520&rows=5");
  });

  test("HTTP errors and network failures become Dutch tool errors", async () => {
    await expect(geocode("x", { fetch: fakeFetch({}, 500).fetch })).rejects.toThrow("PDOK gaf HTTP 500");
    await expect(
      geocode("x", {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toThrow("PDOK niet bereikbaar");
  });

  test("parseWktPoint", () => {
    expect(parseWktPoint("POINT(5.1 52.2)")).toEqual({ lng: 5.1, lat: 52.2 });
    expect(parseWktPoint("LINESTRING(1 2, 3 4)")).toBeNull();
  });
});

describe("geocode / reverseGeocode tools", () => {
  test("geocode adds the 8-digit RD; reverseGeocode takes any point notation", async () => {
    const tools = mapTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), fetch: fakeFetch(FREE).fetch });
    expect(await runTool(tools.geocode, { query: "Stikkerstraat 10 Arnhem" })).toEqual({ results: [{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", latLng: { lat: 51.95386777, lng: 5.87232125 }, rdText: "1883 4407" }] });
    const reverse = mapTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), fetch: fakeFetch(REVERSE).fetch });
    expect(await runTool(reverse.reverseGeocode, { point: "188362 440722" })).toEqual({ results: [{ name: "Mr D.U. Stikkerstraat 10, 6842CW Arnhem", type: "adres", distanceM: 15 }] });
    expect(await runTool(reverse.geocode, { query: "" })).toEqual({ error: "Zoekterm moet 1 tot 200 tekens zijn" });
  });
});
