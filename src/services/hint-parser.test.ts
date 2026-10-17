import { describe, expect, test } from "bun:test";
import { DEFAULT_AREAS, parseHintArticle } from "./hint-parser";

const sample =
  `<div><strong>Hint 14:00</strong><br>Merida schiet haar pijlen...<br>` +
  `Alpha: <img src="https://cdn.jotihunt.net/a.png"><br>` +
  `Bravo: -<br>` +
  `Charlie: tweeduizend honderdzesentwintig<br>` +
  `Delta:&nbsp;--<br>` +
  `Echo: <img src="https://cdn.jotihunt.net/e.png"></div>`;

describe("parseHintArticle", () => {
  test("returns an entry for every area", () => {
    const result = parseHintArticle(sample);
    expect(Object.keys(result).sort()).toEqual([...DEFAULT_AREAS].sort());
  });

  test("extracts image snippets", () => {
    const result = parseHintArticle(sample);
    expect(result.alpha.none).toBe(false);
    expect(result.alpha.snippet).toContain("a.png");
    expect(result.alpha.snippet).not.toContain("Bravo");
    expect(result.echo.snippet).toContain("e.png");
  });

  test("extracts text snippets", () => {
    expect(parseHintArticle(sample).charlie.snippet).toContain("tweeduizend honderdzesentwintig");
  });

  test("marks dash-only areas as none", () => {
    const result = parseHintArticle(sample);
    expect(result.bravo).toEqual({ snippet: null, none: true });
    expect(result.delta).toEqual({ snippet: null, none: true });
  });

  test("areas the article never names are none once another area has a part", () => {
    expect(parseHintArticle(sample).foxtrot).toEqual({ snippet: null, none: true });
    expect(parseHintArticle(sample).oscar).toEqual({ snippet: null, none: true });
  });

  test("an area named elsewhere (e.g. a file name) but without a label keeps a null snippet", () => {
    const html = `${sample}<br><a href="https://cdn.jotihunt.net/hint-foxtrot.png">plaatje</a>`;
    expect(parseHintArticle(html).foxtrot).toEqual({ snippet: null, none: false });
  });

  test("an area label with nothing after it is none", () => {
    const result = parseHintArticle("<div>Alpha: 1234 5678</div><div>Bravo:<br><br></div><div> <br></div><div>Charlie: 4321</div>");
    expect(result.bravo).toEqual({ snippet: null, none: true });
    expect(result.charlie.snippet).toContain("4321");
  });

  test("image-only article (2025 style) yields no snippets", () => {
    const html =
      `<div><figure data-trix-attachment="{&quot;filename&quot;:&quot;Hint Oscar.png&quot;}">` +
      `<img src="https://cdn.jotihunt.net/NEL.png"></figure></div>`;
    const result = parseHintArticle(html);
    for (const area of DEFAULT_AREAS) expect(result[area]).toEqual({ snippet: null, none: false });
  });

  test("is case-insensitive", () => {
    const result = parseHintArticle("<div>alpha: 1234 5678<br>BRAVO: -</div>");
    expect(result.alpha.snippet).toContain("1234 5678");
    expect(result.bravo.none).toBe(true);
  });

  test("respects custom area names", () => {
    const result = parseHintArticle(sample, ["Alpha", "Bravo"]);
    expect(Object.keys(result)).toEqual(["alpha", "bravo"]);
  });
});
