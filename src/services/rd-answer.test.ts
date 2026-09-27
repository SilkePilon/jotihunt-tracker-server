import { describe, expect, test } from "bun:test";
import { parseRdAnswer } from "./rd-answer";

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
