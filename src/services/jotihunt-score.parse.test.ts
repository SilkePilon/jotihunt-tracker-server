import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScorePage, scoreValue } from "./jotihunt-score.parse";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8");

describe("scoreValue", () => {
  test("empty is 0, ? is unknown, numbers as shown", () => {
    expect(scoreValue("")).toBe(0);
    expect(scoreValue("  ")).toBe(0);
    expect(scoreValue("?")).toBeNull();
    expect(scoreValue("145")).toBe(145);
    expect(scoreValue("1.234")).toBe(1234);
    expect(scoreValue("-10")).toBe(-10);
    expect(scoreValue("−10")).toBe(-10);
    expect(scoreValue("veel")).toBeNull();
  });
});

describe("parseScorePage", () => {
  test("the real dashboard (17 Oct, morning): 2 points for assignments, Hints ?", () => {
    expect(parseScorePage(fixture("dashboard-points.html"))).toEqual({
      total: 2,
      parts: { hunts: 0, counterHunts: 0, assignments: 2, photoAssignments: 0, hints: null, penalty: 0 },
    });
  });

  test("the real dashboard before any points: empty values are 0, Hints ? is null", () => {
    expect(parseScorePage(fixture("dashboard-points-empty.html"))).toEqual({
      total: 0,
      parts: { hunts: 0, counterHunts: 0, assignments: 0, photoAssignments: 0, hints: null, penalty: 0 },
    });
  });

  test("the same markup with numbers (synthetic)", () => {
    expect(parseScorePage(fixture("dashboard-points-synthetic.html"))).toEqual({
      total: 145,
      parts: { hunts: 70, counterHunts: 20, assignments: 40, photoAssignments: 25, hints: null, penalty: 10 },
    });
  });

  test("a penalty shown as a negative number is stored positive", () => {
    const html = fixture("dashboard-points-synthetic.html").replace(/(Strafpunten:\s*<\/div>\s*)10/, "$1-10");
    expect(parseScorePage(html)?.parts.penalty).toBe(10);
  });

  test("the total on the same line, and known hints", () => {
    const html = `<div>Voorlopig aantal punten: <span>12</span></div><div><div class="font-bold">Hints: </div>3</div>`;
    expect(parseScorePage(html)).toEqual({ total: 12, parts: { hunts: null, counterHunts: null, assignments: null, photoAssignments: null, hints: 3, penalty: null } });
  });

  test("a page without the score card is null", () => {
    expect(parseScorePage("<main><h1>Inloggen</h1></main>")).toBeNull();
    expect(parseScorePage(fixture("assignment-open.html"))).toBeNull();
  });
});
