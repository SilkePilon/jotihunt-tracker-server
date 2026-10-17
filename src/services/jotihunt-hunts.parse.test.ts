import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignSiteKeys, classifyStatus, columnsFromHeaders, parseHuntsPage, parseSiteHuntTime, siteKeyOf } from "./jotihunt-hunts.parse";

const now = new Date("2026-10-17T19:50:00Z");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8");

describe("parseSiteHuntTime", () => {
  test("the site's formats, in Amsterdam time (CEST in October)", () => {
    expect(parseSiteHuntTime("2026-10-17 21:03:00", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
    expect(parseSiteHuntTime("2026-10-17 21:03", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
    expect(parseSiteHuntTime("17-10-2026 21:03", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
    expect(parseSiteHuntTime("17/10/2026 21:03:15", now)).toEqual(new Date("2026-10-17T19:03:15Z"));
  });
  test("winter time and the DST switch", () => {
    expect(parseSiteHuntTime("2026-12-01 12:00:00", now)).toEqual(new Date("2026-12-01T11:00:00Z"));
    expect(parseSiteHuntTime("2026-10-25 04:00:00", now)).toEqual(new Date("2026-10-25T03:00:00Z"));
  });
  test("a clock time alone is the most recent one", () => {
    expect(parseSiteHuntTime("21:03", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
    expect(parseSiteHuntTime("23:50", now)).toEqual(new Date("2026-10-16T21:50:00Z"));
  });
  test("unknown text is null", () => {
    for (const text of ["", "  ", "gisteren", null, undefined, "25:99", "2026-13-01 10:00"]) expect(parseSiteHuntTime(text, now)).toBeNull();
  });
});

describe("columnsFromHeaders", () => {
  test("finds the five columns by header text, in any order and next to other columns", () => {
    expect(columnsFromHeaders(["Deelgebied", "Huntcode", "Status", "Punten", "Hunttijd"])).toEqual({ area: 0, huntCode: 1, status: 2, points: 3, huntTime: 4 });
    expect(columnsFromHeaders(["HUNTTIJD", "Extra", "deelgebied", "Punten", "Status", "Hunt code"])).toEqual({ huntTime: 0, area: 2, points: 3, status: 4, huntCode: 5 });
  });
  test("null when one is missing", () => {
    expect(columnsFromHeaders([])).toBeNull();
    expect(columnsFromHeaders(["Deelgebied", "Huntcode", "Status", "Punten"])).toBeNull();
  });
});

describe("classifyStatus", () => {
  test("each class by text", () => {
    expect(classifyStatus("Wacht op bevestiging", 0)).toBe("pending");
    expect(classifyStatus("In afwachting", 0)).toBe("pending");
    expect(classifyStatus("In behandeling", 0)).toBe("pending");
    expect(classifyStatus("Ingediend", 0)).toBe("pending");
    expect(classifyStatus("Goedgekeurd", 10)).toBe("approved");
    expect(classifyStatus("Bevestigd", 0)).toBe("approved");
    expect(classifyStatus("Punten toegekend", 0)).toBe("approved");
    expect(classifyStatus("Afgekeurd", 0)).toBe("rejected");
    expect(classifyStatus("Niet goedgekeurd", 0)).toBe("rejected");
    expect(classifyStatus("Ongeldig", 0)).toBe("rejected");
  });
  test("points > 0 without a known text is approved; nothing known is unknown", () => {
    expect(classifyStatus("", 6)).toBe("approved");
    expect(classifyStatus("", 0)).toBe("unknown");
    expect(classifyStatus("Hmm", 0)).toBe("unknown");
  });
});

describe("parseHuntsPage", () => {
  test("the real page without hunts: none, no warning", () => {
    expect(parseHuntsPage(fixture("hunts-page-real-empty.html"), now)).toEqual({ hunts: [], warning: null, found: true });
  });

  test("the real markup with rows parses exactly", () => {
    const tenTwelve = new Date("2026-10-17T08:12:00Z");
    expect(parseHuntsPage(fixture("hunts-page-real-rows.html"), now)).toEqual({
      found: true,
      warning: null,
      hunts: [
        {
          siteKey: `time:alpha:${tenTwelve.toISOString()}`,
          area: "alpha",
          huntTime: tenTwelve,
          huntTimeText: "2026-10-17 10:12:00",
          status: "pending",
          statusText: "Wacht op bevestiging",
          points: 0,
          huntCode: null,
          location: null,
        },
        {
          siteKey: "code:GNcrZRZ",
          area: "bravo",
          huntTime: new Date("2026-10-17T07:45:00Z"),
          huntTimeText: "17-10-2026 09:45",
          status: "approved",
          statusText: "Goedgekeurd",
          points: 10,
          huntCode: "GNcrZRZ",
          location: null,
        },
        {
          siteKey: "code:XK4PQ",
          area: "charlie",
          huntTime: new Date("2026-10-17T06:03:27Z"),
          huntTimeText: "2026-10-17 08:03:27",
          status: "rejected",
          statusText: "Afgekeurd",
          points: 0,
          huntCode: "XK4PQ",
          location: null,
        },
        {
          siteKey: `time:delta:${tenTwelve.toISOString()}`,
          area: "delta",
          huntTime: tenTwelve,
          huntTimeText: "2026-10-17 10:12:00",
          status: "pending",
          statusText: "In behandeling",
          points: 0,
          huntCode: null,
          location: null,
        },
      ],
    });
  });

  test("a page without the hunts table warns", () => {
    expect(parseHuntsPage("<main><p>Er ging iets mis</p></main>", now)).toEqual({ hunts: [], warning: "Unknown hunts layout (no tables)", found: false });
    const other = parseHuntsPage("<table><thead><tr><th>Naam</th><th>Telefoon</th></tr></thead><tbody></tbody></table>", now);
    expect(other).toMatchObject({ hunts: [], found: false });
    expect(other.warning).toBe('Unknown hunts layout (["Naam", "Telefoon"])');
  });

  test("a placeholder row is skipped; a row without a deelgebied warns", () => {
    const table = (rows: string) => `<table><thead><th>Deelgebied</th><th>Huntcode</th><th>Status</th><th>Punten</th><th>Hunttijd</th></thead><tbody>${rows}</tbody></table>`;
    expect(parseHuntsPage(table('<tr><td colspan="5">Nog geen hunts</td></tr>'), now)).toEqual({ hunts: [], warning: null, found: true });
    const { hunts, warning } = parseHuntsPage(
      table(
        "<tr><td></td><td>X</td><td>Goedgekeurd</td><td>3</td><td>2026-10-17 10:00:00</td></tr><tr><td>Echo&nbsp;</td><td></td><td><span>Afgekeurd</span></td><td>0</td><td>2026-10-17 10:00:00</td></tr>",
      ),
      now,
    );
    expect(hunts.map((hunt) => [hunt.area, hunt.status])).toEqual([["echo", "rejected"]]);
    expect(warning).toContain("without a deelgebied");
  });
});

describe("siteKeyOf / assignSiteKeys", () => {
  const time = new Date("2026-10-17T19:03:00Z");
  const base = { area: "alpha", huntCode: null, huntTime: time, huntTimeText: "21:03" };
  test("code, else area + time, else area + raw text", () => {
    expect(siteKeyOf({ ...base, huntCode: "ABC" })).toBe("code:ABC");
    expect(siteKeyOf(base)).toBe("time:alpha:2026-10-17T19:03:00.000Z");
    expect(siteKeyOf({ ...base, huntTime: null, huntTimeText: " ?? " })).toBe("raw:alpha:??");
  });
  test("a key seen twice in one page gets a suffix", () => {
    const hunts = assignSiteKeys([
      { ...base, siteKey: "" },
      { ...base, siteKey: "" },
    ]);
    expect(hunts.map((hunt) => hunt.siteKey)).toEqual([`time:alpha:${time.toISOString()}`, `time:alpha:${time.toISOString()}#2`]);
  });
});
