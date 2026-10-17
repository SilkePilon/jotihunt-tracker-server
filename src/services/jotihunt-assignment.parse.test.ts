import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAssignmentPage, pointsOf } from "./jotihunt-assignment.parse";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8");

describe("parseAssignmentPage", () => {
  test("not handed in (the real upload form)", () => {
    expect(parseAssignmentPage(fixture("assignment-open.html"))).toEqual({ found: true, submitted: false, imageUrl: null, rating: null, judgement: null, judged: false, points: null });
  });

  test("handed in, not judged, no rating (real)", () => {
    expect(parseAssignmentPage(fixture("assignment-submitted.html"))).toEqual({
      found: true,
      submitted: true,
      imageUrl: "https://cdn.jotihunt.net/jotihunt2026/media/1000000094/conversions/Clan-Portrait-Groep-large.jpg",
      rating: null,
      judgement: "Nog niet beoordeeld",
      judged: false,
      points: null,
    });
  });

  test("handed in with our rating (real); the article's own images are not the photo", () => {
    expect(parseAssignmentPage(fixture("assignment-submitted-rated.html"))).toEqual({
      found: true,
      submitted: true,
      imageUrl: "https://cdn.jotihunt.net/jotihunt2026/media/1000000054/conversions/Wandje-van-tichelaar-Groep-large.jpg",
      rating: 4,
      judgement: "Nog niet beoordeeld",
      judged: false,
      points: null,
    });
  });

  test("judged (synthetic footer): judgement as shown, points read from it", () => {
    expect(parseAssignmentPage(fixture("assignment-judged-synthetic.html"))).toMatchObject({ submitted: true, rating: 4, judgement: "Beoordeeld: 25 punten", judged: true, points: 25 });
  });

  test("only http(s) images count as the photo", () => {
    const html = fixture("assignment-submitted.html").replace(/src="https:\/\/cdn[^"]+"/, 'src="javascript:alert(1)"');
    expect(parseAssignmentPage(html).imageUrl).toBeNull();
  });

  test("a page without the Insturen card", () => {
    expect(parseAssignmentPage("<main><h1>Inloggen</h1></main>")).toMatchObject({ found: false, submitted: false });
  });
});

describe("pointsOf", () => {
  test("a number of points in the judgement text", () => {
    expect(pointsOf("Beoordeeld: 25 punten")).toBe(25);
    expect(pointsOf("Goedgekeurd (12 pt) van 30")).toBe(12);
    expect(pointsOf("Score: 7")).toBe(7);
    expect(pointsOf("Goedgekeurd")).toBeNull();
    expect(pointsOf("Nog niet beoordeeld")).toBeNull();
    expect(pointsOf(null)).toBeNull();
  });
});
