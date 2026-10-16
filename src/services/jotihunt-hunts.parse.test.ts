import { describe, expect, test } from "bun:test";
import { columnsFromHeaders, parseHuntsTable, parseSiteHuntTime, siteKeyOf } from "./jotihunt-hunts.parse";

const now = new Date(2026, 9, 17, 21, 30);

describe("parseSiteHuntTime", () => {
  test("date and time formats, in server local time", () => {
    expect(parseSiteHuntTime("2026-10-17 21:03:00", now)).toEqual(new Date(2026, 9, 17, 21, 3, 0));
    expect(parseSiteHuntTime("2026-10-17 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("17-10-2026 21:03", now)).toEqual(new Date(2026, 9, 17, 21, 3));
    expect(parseSiteHuntTime("17/10/2026 21:03:15", now)).toEqual(new Date(2026, 9, 17, 21, 3, 15));
    expect(parseSiteHuntTime("2026-10-17T19:03:00Z", now)).toEqual(new Date("2026-10-17T19:03:00Z"));
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
  test("null without an area or time column", () => {
    expect(columnsFromHeaders([])).toBeNull();
    expect(columnsFromHeaders(["Foo", "Bar"])).toBeNull();
  });
});

describe("parseHuntsTable", () => {
  test("the old layout: rows with and without a code are kept; placeholder rows skipped", () => {
    const { hunts, warning } = parseHuntsTable(
      {
        headers: ["Deelgebied", "Huntcode", "Status", "Punten", "Tijd"],
        rows: [["Alpha", " GN cr ZRZ ", "Goedgekeurd", "6", "2026-10-17 21:03:00"], ["Bravo", "", "In behandeling", "", "2026-10-17 21:10:00"], ["Charlie", "-", "Afgekeurd", "0", "21:20"], ["Nog geen hunts"]],
      },
      now,
    );
    expect(warning).toBeNull();
    expect(hunts).toEqual([
      { area: "Alpha", huntCode: "GNcrZRZ", status: "Goedgekeurd", points: 6, huntTime: "2026-10-17 21:03:00", time: new Date(2026, 9, 17, 21, 3) },
      { area: "Bravo", huntCode: null, status: "In behandeling", points: 0, huntTime: "2026-10-17 21:10:00", time: new Date(2026, 9, 17, 21, 10) },
      { area: "Charlie", huntCode: null, status: "Afgekeurd", points: 0, huntTime: "21:20", time: new Date(2026, 9, 17, 21, 20) },
    ]);
  });

  test("a new layout without a code column, separate date and time columns", () => {
    const { hunts, warning } = parseHuntsTable({ headers: ["Vossenteam", "Datum", "Tijd", "Punten", "Status"], rows: [["Delta", "17-10-2026", "21:03", "3", "Goedgekeurd"]] }, now);
    expect(warning).toBeNull();
    expect(hunts).toEqual([{ area: "Delta", huntCode: null, status: "Goedgekeurd", points: 3, huntTime: "17-10-2026 21:03", time: new Date(2026, 9, 17, 21, 3) }]);
  });

  test("unknown headers: falls back to the old layout and warns", () => {
    const { hunts, warning } = parseHuntsTable({ headers: ["A", "B", "C", "D", "E"], rows: [["Echo", "XYZ", "ok", "6", "21:00"]] }, now);
    expect(warning).toContain("Unknown hunts table layout");
    expect(hunts).toHaveLength(1);
    expect(hunts[0]).toMatchObject({ area: "Echo", huntCode: "XYZ" });
  });

  test("no headers at all: the old layout without a warning", () => {
    expect(parseHuntsTable({ headers: [], rows: [["Echo", "XYZ", "ok", "6", "21:00"]] }, now)).toMatchObject({ warning: null, hunts: [{ area: "Echo" }] });
  });
});

describe("siteKeyOf", () => {
  test("code, else area + time, else area + raw text", () => {
    const time = new Date("2026-10-17T19:03:00Z");
    expect(siteKeyOf({ area: "Alpha", huntCode: "ABC", huntTime: "21:03", time })).toBe("code:ABC");
    expect(siteKeyOf({ area: "Alpha", huntCode: null, huntTime: "21:03", time })).toBe("time:alpha:2026-10-17T19:03:00.000Z");
    expect(siteKeyOf({ area: "Alpha", huntCode: null, huntTime: " ?? ", time: null })).toBe("raw:alpha:??");
  });
});
