import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignSiteKeys, classifyStatus, columnsFromHeaders, extractHuntsPage, parseHuntDetail, parseHuntsPage, parseLocation, parseSiteHuntTime, siteKeyOf } from "./jotihunt-hunts.parse";

const now = new Date(2026, 9, 17, 21, 50);
const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8");
const parseFixture = (name: string) => parseHuntsPage(extractHuntsPage(fixture(name)), now);

describe("parseSiteHuntTime", () => {
  test("date and time formats, in server local time", () => {
    expect(parseSiteHuntTime("2026-10-17 21:03:00", now)).toEqual(new Date(2026, 9, 17, 21, 3, 0));
    expect(parseSiteHuntTime("2026-10-17 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("17-10-2026 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("17/10/2026 21:03:15", now)).toEqual(new Date(2026, 9, 17, 21, 3, 15));
    expect(parseSiteHuntTime("2026-10-17T19:03:00Z", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
  });
  test("Dutch month names", () => {
    expect(parseSiteHuntTime("17 okt 2026 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("za 17 oktober om 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
  });
  test("a clock time alone is the most recent one", () => {
    expect(parseSiteHuntTime("21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("23:50", now)).toEqual(new Date(2026, 9, 16, 23, 50));
  });
  test("unknown text is null", () => {
    for (const text of ["", "  ", "gisteren", null, undefined, "25:99"]) expect(parseSiteHuntTime(text, now)).toBeNull();
  });
});

describe("columnsFromHeaders", () => {
  test("finds columns by header text, in any order", () => {
    expect(columnsFromHeaders(["Tijdstip", "Deelgebied", "Status", "Punten"])).toEqual({ huntTime: 0, area: 1, status: 2, points: 3 });
    expect(columnsFromHeaders(["Deelgebied", "Huntcode", "Status", "Punten", "Hunttijd"])).toEqual({ area: 0, huntCode: 1, status: 2, points: 3, huntTime: 4 });
  });
  test("QR code, location and accuracy columns; the device column is not the fox", () => {
    expect(columnsFromHeaders(["Vossenteam", "Apparaat", "QR-code", "Tijd", "Locatie", "Nauwkeurigheid", "Status", "Punten"])).toEqual({ area: 0, qrCode: 2, huntTime: 3, location: 4, accuracy: 5, status: 6, points: 7 });
  });
  test("null without an area or time column", () => {
    expect(columnsFromHeaders([])).toBeNull();
    expect(columnsFromHeaders(["Foo", "Bar"])).toBeNull();
  });
});

describe("classifyStatus", () => {
  test("each class by text", () => {
    expect(classifyStatus("Wacht op bevestiging", 0)).toBe("pending");
    expect(classifyStatus("In afwachting", 0)).toBe("pending");
    expect(classifyStatus("Wordt beoordeeld", 0)).toBe("pending");
    expect(classifyStatus("Goedgekeurd", 10)).toBe("approved");
    expect(classifyStatus("Geaccepteerd", 0)).toBe("approved");
    expect(classifyStatus("Punten toegekend", 0)).toBe("approved");
    expect(classifyStatus("Afgekeurd", 0)).toBe("rejected");
    expect(classifyStatus("Niet goedgekeurd", 0)).toBe("rejected");
    expect(classifyStatus("Ongeldig", 0)).toBe("rejected");
  });
  test("points > 0 without a known text is approved", () => {
    expect(classifyStatus("", 6)).toBe("approved");
    expect(classifyStatus("???", 1)).toBe("approved");
  });
  test("nothing known is unknown", () => {
    expect(classifyStatus("", 0)).toBe("unknown");
    expect(classifyStatus("Hmm", 0)).toBe("unknown");
  });
});

describe("parseLocation", () => {
  test("coordinates in text, with accuracy", () => {
    expect(parseLocation(["52.0123, 5.9876 (±12 m)"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: 12 });
    expect(parseLocation(["52,0123 5,9876"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
    expect(parseLocation(["Locatie: 52.0123,5.9876", "Nauwkeurigheid: ± 7,5 m"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: 7.5 });
  });
  test("map links", () => {
    expect(parseLocation(["https://www.google.com/maps?q=52.0123,5.9876"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
    expect(parseLocation(["https://www.google.com/maps/place/@52.0123,5.9876,17z/data=!3m1"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
    expect(parseLocation(["https://maps.apple.com/?ll=52.0123,5.9876&z=16"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
    expect(parseLocation(["https://www.openstreetmap.org/?mlat=52.0123&mlon=5.9876#map=17"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
  });
  test("a metre count inside a URL is no accuracy", () => {
    expect(parseLocation(["https://www.google.com/maps/@52.0123,5.9876,150m/data=!3m1"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
  });
  test("data attributes", () => {
    expect(parseLocation([], { "data-lat": "52.0123", "data-lng": "5.9876", "data-accuracy": "12" })).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: 12 });
    expect(parseLocation([], { "data-latitude": "52.0123", "data-longitude": "5.9876" })).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
  });
  test("lng, lat order is swapped back", () => {
    expect(parseLocation(["5.9876, 52.0123"])).toEqual({ lat: 52.0123, lng: 5.9876, accuracy: null });
  });
  test("numbers outside the Netherlands are no location", () => {
    expect(parseLocation(["10.5, 120.2"])).toBeNull();
    expect(parseLocation(["48.1234, 5.2345"])).toBeNull();
    expect(parseLocation(["21:03", "10 punten", "12 m"])).toBeNull();
    expect(parseLocation([], { "data-lat": "12", "data-lng": "99" })).toBeNull();
  });
});

describe("parseHuntsPage", () => {
  test("(a) table with coordinates, accuracy and QR code in cells", () => {
    expect(parseFixture("hunts-page-table-coords.html")).toEqual({
      warning: null,
      hunts: [
        { siteKey: "qr:QR-7F3A9C", area: "alpha", huntTime: new Date(2026, 9, 17, 21, 43), huntTimeText: "17-10-2026 21:43", status: "pending", statusText: "Wacht op bevestiging", points: 0, qrCode: "QR-7F3A9C", huntCode: null, location: { lat: 52.0123, lng: 5.9876, accuracy: 12 }, detailUrl: null },
        { siteKey: "qr:QR-11B2E0", area: "delta", huntTime: new Date(2026, 9, 17, 21, 20), huntTimeText: "17-10-2026 21:20", status: "approved", statusText: "Goedgekeurd", points: 10, qrCode: "QR-11B2E0", huntCode: null, location: { lat: 52.15, lng: 5.6, accuracy: 8 }, detailUrl: null },
        { siteKey: "qr:QR-99AA01", area: "echo", huntTime: new Date(2026, 9, 17, 19, 55), huntTimeText: "17-10-2026 19:55", status: "rejected", statusText: "Afgekeurd", points: 0, qrCode: "QR-99AA01", huntCode: null, location: { lat: 51.98, lng: 5.7, accuracy: 25.5 }, detailUrl: null },
      ],
    });
  });

  test("(b) table with map links and a separate accuracy column; the device column is ignored", () => {
    const bravoTime = new Date(2026, 9, 17, 21, 43, 10);
    const charlieTime = new Date(2026, 9, 17, 20, 5);
    const foxtrotTime = new Date(2026, 9, 17, 18, 30);
    expect(parseFixture("hunts-page-table-maplink.html")).toEqual({
      warning: null,
      hunts: [
        { siteKey: `time:bravo:${bravoTime.toISOString()}`, area: "bravo", huntTime: bravoTime, huntTimeText: "2026-10-17 21:43:10", status: "pending", statusText: "In afwachting", points: 0, qrCode: null, huntCode: null, location: { lat: 52.0123, lng: 5.9876, accuracy: 12 }, detailUrl: null },
        { siteKey: `time:charlie:${charlieTime.toISOString()}`, area: "charlie", huntTime: charlieTime, huntTimeText: "2026-10-17 20:05:00", status: "approved", statusText: "Geaccepteerd", points: 8, qrCode: null, huntCode: null, location: { lat: 52.2101, lng: 5.8899, accuracy: 30 }, detailUrl: null },
        { siteKey: `time:foxtrot:${foxtrotTime.toISOString()}`, area: "foxtrot", huntTime: foxtrotTime, huntTimeText: "2026-10-17 18:30:00", status: "rejected", statusText: "Afgekeurd: buiten gebied", points: 0, qrCode: null, huntCode: null, location: null, detailUrl: null },
      ],
    });
  });

  test("(c) cards with data attributes and detail links", () => {
    expect(parseFixture("hunts-page-cards-detail.html")).toEqual({
      warning: null,
      hunts: [
        { siteKey: "id:123", area: "alpha", huntTime: new Date(2026, 9, 17, 21, 43), huntTimeText: "21:43", status: "pending", statusText: "Wacht op bevestiging", points: 0, qrCode: null, huntCode: null, location: { lat: 52.0123, lng: 5.9876, accuracy: 12 }, detailUrl: "/hunts/123" },
        { siteKey: "id:124", area: "bravo", huntTime: new Date(2026, 9, 17, 20, 10), huntTimeText: "20:10", status: "approved", statusText: "Goedgekeurd", points: 10, qrCode: null, huntCode: null, location: null, detailUrl: "/hunts/124" },
      ],
    });
  });

  test("the old code layout still parses and keys by code", () => {
    const { hunts, warning } = parseHuntsPage(
      { headers: ["Deelgebied", "Huntcode", "Status", "Punten", "Tijd"], rows: [row(["Alpha", " GN cr ZRZ ", "Goedgekeurd", "6", "2026-10-17 21:03:00"]), row(["Nog geen hunts"])] },
      now,
    );
    expect(warning).toBeNull();
    expect(hunts).toHaveLength(1);
    expect(hunts[0]).toMatchObject({ siteKey: "code:GNcrZRZ", huntCode: "GNcrZRZ", area: "alpha", status: "approved", points: 6 });
  });

  test("separate date and time columns are read together", () => {
    const { hunts } = parseHuntsPage({ headers: ["Vossenteam", "Datum", "Tijd", "Punten", "Status"], rows: [row(["Delta", "17-10-2026", "21:03", "3", "Goedgekeurd"])] }, now);
    expect(hunts[0]).toMatchObject({ huntTime: new Date(2026, 9, 17, 21, 3), huntTimeText: "17-10-2026 21:03" });
  });

  test("unknown headers: warns and still finds what it can from the cell contents", () => {
    const { hunts, warning } = parseHuntsPage({ headers: ["A", "B", "C"], rows: [row(["Echo", "21:00", "Wacht op bevestiging"])] }, now);
    expect(warning).toContain("Unknown hunts layout");
    expect(hunts).toEqual([expect.objectContaining({ area: "echo", status: "pending", huntTime: new Date(2026, 9, 17, 21, 0) })]);
  });

  test("rows that cannot be read warn, never throw", () => {
    const { hunts, warning } = parseHuntsPage({ headers: ["Vossenteam", "Tijd"], rows: [row(["???", "!!!"]), row(["", ""])] }, now);
    expect(hunts).toEqual([]);
    expect(warning).toContain("none could be read");
  });

  test("a page without a table or hunt items: no hunts and a warning", () => {
    const page = extractHuntsPage("<html><body><main><p>Er ging iets mis</p></main></body></html>");
    expect(page).toEqual({ headers: [], rows: [] });
    const { hunts, warning } = parseHuntsPage(page, now);
    expect(hunts).toEqual([]);
    expect(warning).toContain("No hunts table");
  });

  test("an empty hunts table is fine", () => {
    expect(parseHuntsPage(extractHuntsPage("<table><thead><tr><th>Vossenteam</th><th>Tijd</th></tr></thead><tbody></tbody></table>"), now)).toEqual({ hunts: [], warning: null });
  });

  test("broken HTML does not throw", () => {
    expect(() => parseHuntsPage(extractHuntsPage("<table><tr><td>Alpha<td>21:00<tr><td><b>Bravo</td><td>21:10</table></div></span><"), now)).not.toThrow();
    const { hunts } = parseHuntsPage(extractHuntsPage("<table><tr><td>Alpha<td>21:00<tr><td><b>Bravo</td><td>21:10</table>"), now);
    expect(hunts.map((hunt) => hunt.area)).toEqual(["alpha", "bravo"]);
  });
});

describe("parseHuntDetail", () => {
  test("location, accuracy and QR code from a detail page", () => {
    expect(parseHuntDetail(fixture("hunt-detail.html"))).toEqual({ location: { lat: 52.05, lng: 5.65, accuracy: 9 }, qrCode: "AB12CD34" });
  });
  test("a coordinate only in a map script", () => {
    expect(parseHuntDetail("<main><div id=map></div><script>L.marker([52.05, 5.65]).addTo(map)</script></main>")).toEqual({ location: { lat: 52.05, lng: 5.65, accuracy: null }, qrCode: null });
  });
  test("nothing known", () => {
    expect(parseHuntDetail("<p>Niet gevonden</p>")).toEqual({ location: null, qrCode: null });
  });
});

describe("siteKeyOf / assignSiteKeys", () => {
  const time = new Date("2026-10-17T19:03:00Z");
  const base = { area: "alpha", qrCode: null, huntCode: null, detailUrl: null, huntTime: time, huntTimeText: "21:03" };
  test("QR code, else code, else detail id, else area + time, else area + raw text", () => {
    expect(siteKeyOf({ ...base, qrCode: "Q1", huntCode: "ABC", detailUrl: "/hunts/9" })).toBe("qr:Q1");
    expect(siteKeyOf({ ...base, huntCode: "ABC", detailUrl: "/hunts/9" })).toBe("code:ABC");
    expect(siteKeyOf({ ...base, detailUrl: "https://jotihunt.nl/hunts/9?x=1" })).toBe("id:9");
    expect(siteKeyOf(base)).toBe("time:alpha:2026-10-17T19:03:00.000Z");
    expect(siteKeyOf({ ...base, huntTime: null, huntTimeText: " ?? " })).toBe("raw:alpha:??");
  });
  test("a key seen twice in one page gets a suffix", () => {
    const hunts = assignSiteKeys([{ ...base, siteKey: "" }, { ...base, siteKey: "" }]);
    expect(hunts.map((hunt) => hunt.siteKey)).toEqual([`time:alpha:${time.toISOString()}`, `time:alpha:${time.toISOString()}#2`]);
  });
});

function row(cells: string[]) {
  return { cells, links: [], attrs: {}, html: "" };
}
