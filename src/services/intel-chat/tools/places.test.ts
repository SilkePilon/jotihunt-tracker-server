import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fromRd } from "../../rd-answer";
import { geminiReply, localGoogle, mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { createTurnBudget, type IntelToolContext } from "./context";
import { OVERPASS_URL, aerialPhotoUrl, placesTools } from "./places";

const HQ = "188362 440722";
const hq = fromRd(188_362, 440_722);
/** A point `dy` metres north of HQ (RD) */
const north = (dy: number) => {
  const { lat, lng } = fromRd(188_362, 440_722 + dy);
  return { lat, lon: lng };
};
const LIMIT = { error: "Limiet voor deze vraag bereikt" };

type Call = { url: string; init: RequestInit };

/** A fake fetch: Overpass answers `overpass`, PDOK free search answers one hit at HQ */
function fakeFetch(overpass: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("https://api.pdok.nl/")) return Response.json({ response: { docs: [{ weergavenaam: "Arnhem", type: "woonplaats", centroide_ll: `POINT(${hq.lng} ${hq.lat})` }] } });
    return Response.json(overpass, { status });
  };
  return { fetch, calls };
}

const tools = (extra: Partial<IntelToolContext>) => placesTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), budget: createTurnBudget(), ...extra });
const queryOf = (call: Call) =>
  decodeURIComponent(
    String(call.init.body)
      .replace(/^data=/, "")
      .replace(/\+/g, " "),
  );

describe("findPlaces", () => {
  const ELEMENTS = {
    elements: [
      { type: "node", id: 1, ...north(500), tags: { amenity: "place_of_worship", religion: "christian", name: "Eusebiuskerk" } },
      { type: "way", id: 2, center: north(200), tags: { man_made: "windmill", name: "De Kroon" } },
      { type: "node", id: 3, ...north(1000), tags: { building: "church" } },
      { type: "node", id: 4, ...north(5000), tags: { man_made: "windmill", name: "Te ver" } },
    ],
  };

  test("asks Overpass around a point and returns the places nearest first", async () => {
    const { fetch, calls } = fakeFetch(ELEMENTS);
    const result = (await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: ["church", "windmill"] })) as { places: Record<string, unknown>[] };
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OVERPASS_URL);
    expect(calls[0].init.method).toBe("POST");
    const query = queryOf(calls[0]);
    const around = `(around:3000,${hq.lat.toFixed(6)},${hq.lng.toFixed(6)})`;
    expect(query).toStartWith("[out:json][timeout:15];");
    expect(query).toContain(`nwr["amenity"="place_of_worship"]${around};`);
    expect(query).toContain(`nwr["building"="church"]${around};`);
    expect(query).toContain(`nwr["man_made"="windmill"]${around};`);
    expect(result.places.map((place) => [place.name, place.kind])).toEqual([
      ["De Kroon", "windmill"],
      ["Eusebiuskerk", "church"],
      [null, "church"],
    ]);
    expect(result.places[0]).toMatchObject({ distanceM: 200, rdText: "1884 4409" });
    expect(result.places[0].latLng).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
  });

  test("a place name is looked up with PDOK first; the radius is at most 15 km", async () => {
    const { fetch, calls } = fakeFetch({ elements: [] });
    expect(await runTool(tools({ fetch }).findPlaces, { near: "Arnhem", radiusM: 50_000, kinds: ["station"] })).toEqual({ places: [] });
    expect(calls[0].url).toStartWith("https://api.pdok.nl/");
    expect(queryOf(calls[1])).toContain(`nwr["railway"="station"](around:15000,`);
  });

  test("bus routes: line with from → to, at the nearest stop of the route", async () => {
    const { fetch, calls } = fakeFetch({
      elements: [
        {
          type: "relation",
          id: 10,
          center: north(2000),
          members: [
            { type: "node", ref: 21, role: "stop" },
            { type: "node", ref: 22, role: "stop" },
            { type: "way", ref: 99, role: "" },
          ],
          tags: { type: "route", route: "bus", ref: "12", from: "Arnhem Centraal", to: "Ede" },
        },
        { type: "relation", id: 11, center: north(800), members: [], tags: { type: "route", route: "bus", ref: "3" } },
        { type: "node", id: 21, ...north(900) },
        { type: "node", id: 22, ...north(300) },
      ],
    });
    const result = (await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: ["bus_route"] })) as { places: Record<string, unknown>[] };
    expect(queryOf(calls[0])).toContain('relation["route"="bus"]');
    expect(result.places).toEqual([
      expect.objectContaining({ kind: "bus_route", name: null, distanceM: 300, detail: "lijn 12: Arnhem Centraal → Ede" }),
      expect.objectContaining({ kind: "bus_route", distanceM: 800, detail: "lijn 3" }),
    ]);
  });

  test("any:<tag>=<value>, unknown kinds and unsafe tags", async () => {
    const { fetch, calls } = fakeFetch({ elements: [{ type: "node", id: 1, ...north(100), tags: { amenity: "pub", name: "De Vos" } }] });
    expect(await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: ["any:amenity=pub"] })).toMatchObject({ places: [{ name: "De Vos", kind: "any:amenity=pub" }] });
    expect(queryOf(calls[0])).toContain('nwr["amenity"="pub"]');
    expect(await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: ["kroeg"] })).toEqual({ error: "Onbekende soort plek: kroeg" });
    expect(await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: ['any:name="x"];out;'] })).toEqual({ error: 'Onbekende soort plek: any:name="x"];out;' });
    expect(await runTool(tools({ fetch }).findPlaces, { near: HQ, kinds: [] })).toEqual({ error: "Geef 1 tot 8 soorten plekken" });
  });

  test("at most 25 places", async () => {
    const elements = Array.from({ length: 40 }, (_, i) => ({ type: "node", id: i, ...north(10 * i), tags: { highway: "bus_stop" } }));
    const result = (await runTool(tools({ fetch: fakeFetch({ elements }).fetch }).findPlaces, { near: HQ, kinds: ["bus_stop"] })) as { places: unknown[] };
    expect(result.places).toHaveLength(25);
  });

  test("Overpass failures become a Dutch { error }", async () => {
    expect(await runTool(tools({ fetch: fakeFetch({}, 429).fetch }).findPlaces, { near: HQ, kinds: ["church"] })).toEqual({ error: "Overpass (OpenStreetMap) is druk (HTTP 429); probeer het later" });
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await runTool(tools({ fetch: down }).findPlaces, { near: HQ, kinds: ["church"] })).toEqual({ error: "Overpass (OpenStreetMap) niet bereikbaar" });
  });

  test("at most 4 searches per turn", async () => {
    const { fetch, calls } = fakeFetch({ elements: [] });
    const turn = tools({ fetch });
    for (let i = 0; i < 4; i++) expect(await runTool(turn.findPlaces, { near: HQ, kinds: ["church"] })).toEqual({ places: [] });
    expect(await runTool(turn.findPlaces, { near: HQ, kinds: ["church"] })).toEqual(LIMIT);
    expect(calls).toHaveLength(4);
  });
});

describe("lookAtPoint", () => {
  let stop: (() => void) | null = null;
  beforeAll(connectTestDb);
  beforeEach(clearTestDb);
  afterEach(() => {
    stop?.();
    stop = null;
  });
  afterAll(disconnectTestDb);

  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  function photoFetch(body: BodyInit = JPEG, init: ResponseInit = { headers: { "Content-Type": "image/jpeg" } }) {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return new Response(body, init);
    };
    return { fetch, urls };
  }
  function gemini(respond: () => Response) {
    const bodies: Record<string, unknown>[] = [];
    const google = localGoogle(async (request) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return respond();
    });
    stop = google.stop;
    return { model: google.model("gemini-test"), bodies };
  }

  test("the PDOK WMS URL is an RD box around the point", () => {
    expect(aerialPhotoUrl({ x: 188_362, y: 440_722 }, 150)).toBe(
      "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=Actueel_orthoHR&STYLES=&CRS=EPSG%3A28992&BBOX=188212%2C440572%2C188512%2C440872&WIDTH=768&HEIGHT=768&FORMAT=image%2Fjpeg",
    );
  });

  test("downloads the aerial photo and lets Gemini describe it", async () => {
    const photo = photoFetch();
    const { model, bodies } = gemini(() => geminiReply("Een kerk met een parkeerplaats aan de noordkant."));
    const result = (await runTool(tools({ fetch: photo.fetch, toolModel: model }).lookAtPoint, { point: HQ, zoomM: 300 })) as Record<string, unknown>;
    expect(result.description).toBe("Een kerk met een parkeerplaats aan de noordkant.");
    expect(result.imageUrl).toBe(aerialPhotoUrl({ x: 188_362, y: 440_722 }, 300));
    expect(photo.urls).toEqual([result.imageUrl as string]);
    expect(result.point).toMatchObject({ rdText: "1884 4407", rd: { x: 188_362, y: 440_722 } });
    const parts = (bodies[0].contents as { parts: Record<string, unknown>[] }[])[0].parts;
    expect(parts.some((part) => (part.inlineData as { mimeType?: string } | undefined)?.mimeType === "image/jpeg")).toBe(true);
  });

  test("a photo over 3 MB or that is no image is refused before Gemini", async () => {
    const { model, bodies } = gemini(() => geminiReply("x"));
    const big = photoFetch(new Uint8Array(3 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/jpeg" } });
    expect(await runTool(tools({ fetch: big.fetch, toolModel: model }).lookAtPoint, { point: HQ })).toEqual({ error: "Luchtfoto te groot" });
    const xml = photoFetch("<ServiceException/>", { headers: { "Content-Type": "text/xml" } });
    expect(await runTool(tools({ fetch: xml.fetch, toolModel: model }).lookAtPoint, { point: HQ })).toEqual({ error: "PDOK gaf geen luchtfoto" });
    expect(bodies).toHaveLength(0);
  });

  test("a Gemini failure becomes our Dutch error; a point outside the Netherlands is refused", async () => {
    const { model } = gemini(() => Response.json({ error: { code: 503, message: "overloaded" } }, { status: 503 }));
    expect(await runTool(tools({ fetch: photoFetch().fetch, toolModel: model }).lookAtPoint, { point: HQ })).toEqual({ error: "Gemini-verzoek mislukt (HTTP 503)" });
    expect(await runTool(tools({ fetch: photoFetch().fetch, toolModel: model }).lookAtPoint, { point: "48.85, 2.35" })).toEqual({ error: "Luchtfoto's zijn er alleen voor Nederland" });
  });

  test("at most 3 photos per turn", async () => {
    const photo = photoFetch();
    const { model, bodies } = gemini(() => geminiReply("ok"));
    const turn = tools({ fetch: photo.fetch, toolModel: model });
    for (let i = 0; i < 3; i++) expect(await runTool(turn.lookAtPoint, { point: HQ })).toMatchObject({ description: "ok" });
    expect(await runTool(turn.lookAtPoint, { point: HQ })).toEqual(LIMIT);
    expect(bodies).toHaveLength(3);
  });
});
