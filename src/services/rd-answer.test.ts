import { describe, expect, test } from "bun:test";
import { distanceM } from "./prediction/geo";
import { formatRdAnswer, parseRdAnswer, toRd } from "./rd-answer";

describe("parseRdAnswer", () => {
  test("parses 4+4 digits and converts to WGS84", () => {
    const result = parseRdAnswer("2126 4692");
    expect(result).not.toBeNull();
    expect(result!.x).toBe(212600);
    expect(result!.y).toBe(469200);
    expect(result!.lat).toBeCloseTo(52.2079, 3);
    expect(result!.lng).toBeCloseTo(6.2299, 3);
  });

  test.each([["21264692"], [" 2126   4692 "], ["2126,4692"], ["2126;4692"], ["212600 469200"], ["212600469200"]])(
    "accepts format %p",
    (input) => {
      const result = parseRdAnswer(input);
      expect(result?.x).toBe(212600);
      expect(result?.y).toBe(469200);
    },
  );

  test.each([["doedelzak"], ["12 34"], ["1234 5678 9"], ["2126 469200"], ["0000 0000"], ["2950 4692"], ["2126 6400"], [""]])(
    "rejects %p",
    (input) => {
      expect(parseRdAnswer(input)).toBeNull();
    },
  );
});

describe("formatRdAnswer", () => {
  test("formats hectometres 'XXXX YYYY' that parse back within ~71 m", () => {
    for (const [lng, lat] of [
      [5.38763888888889, 52.15616055555555],
      [5.9, 52.1],
      [6.12345, 51.98765],
    ]) {
      const answer = formatRdAnswer(lng, lat);
      expect(answer).toMatch(/^\d{4} \d{4}$/);
      const parsed = parseRdAnswer(answer)!;
      expect(distanceM([parsed.lng, parsed.lat], [lng, lat])).toBeLessThan(72);
    }
    const amersfoort = parseRdAnswer("1550 4630")!;
    expect(formatRdAnswer(amersfoort.lng, amersfoort.lat)).toBe("1550 4630");
    expect(Math.round(toRd(amersfoort.lng, amersfoort.lat).x)).toBe(155000);
  });
});
