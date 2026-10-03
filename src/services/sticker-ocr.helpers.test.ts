import { describe, expect, test } from "bun:test";
import { parseStickerReading, resolveReadTime } from "./sticker-ocr.helpers";

const answer = (fields: Record<string, unknown>) => JSON.stringify({ code: "GNcrZRZ", codeConfidence: 0.9, time: "11:17", timeConfidence: 0.8, ...fields });

describe("parseStickerReading", () => {
  test("reads plain JSON and keeps the case of the code", () => {
    expect(parseStickerReading(answer({}))).toEqual({ code: "GNcrZRZ", codeConfidence: 0.9, time: "11:17", timeConfidence: 0.8, box: null });
  });

  test("accepts JSON inside ```json fences", () => {
    expect(parseStickerReading("```json\n" + answer({}) + "\n```").code).toBe("GNcrZRZ");
    expect(parseStickerReading("```\n" + answer({}) + "\n```").time).toBe("11:17");
  });

  test("trims the code", () => {
    expect(parseStickerReading(answer({ code: "  Gy3M8XI " })).code).toBe("Gy3M8XI");
  });

  test("an invalid code becomes null with confidence 0", () => {
    for (const code of ["JOTIHUNT 2025", "ab", "abcdefghijklm", "ab-12", "", null, 42]) {
      const reading = parseStickerReading(answer({ code }));
      expect(reading.code).toBeNull();
      expect(reading.codeConfidence).toBe(0);
    }
  });

  test("normalises time variants to HH:MM", () => {
    expect(parseStickerReading(answer({ time: "11:17" })).time).toBe("11:17");
    expect(parseStickerReading(answer({ time: "5.53" })).time).toBe("05:53");
    expect(parseStickerReading(answer({ time: "11;17" })).time).toBe("11:17");
    expect(parseStickerReading(answer({ time: "9 , 05" })).time).toBe("09:05");
    expect(parseStickerReading(answer({ time: "23:59" })).time).toBe("23:59");
  });

  test("an invalid time becomes null with confidence 0", () => {
    for (const time of ["25:00", "12:60", "", "1117", "11:7", null, 1117]) {
      const reading = parseStickerReading(answer({ time }));
      expect(reading.time).toBeNull();
      expect(reading.timeConfidence).toBe(0);
    }
  });

  test("confidences are clamped to 0..1 and missing ones are 0", () => {
    expect(parseStickerReading(answer({ codeConfidence: 1.5, timeConfidence: -2 }))).toMatchObject({ codeConfidence: 1, timeConfidence: 0 });
    expect(parseStickerReading(JSON.stringify({ code: "ABCD", time: "10:00" }))).toEqual({ code: "ABCD", codeConfidence: 0, time: "10:00", timeConfidence: 0, box: null });
    expect(parseStickerReading(answer({ codeConfidence: "0.9" })).codeConfidence).toBe(0);
  });

  test("reads the sticker box as rounded integers", () => {
    expect(parseStickerReading(answer({ box: [120.4, 300, 480, 690.6] })).box).toEqual([120, 300, 480, 691]);
    expect(parseStickerReading(answer({ box: [0, 0, 1000, 1000] })).box).toEqual([0, 0, 1000, 1000]);
  });

  test("an invalid box becomes null without failing the reading", () => {
    for (const box of [undefined, null, [1, 2, 3], [1, 2, 3, 4, 5], [0, 0, 1001, 10], [-1, 0, 10, 10], [500, 0, 400, 10], [0, 500, 10, 500], ["1", 2, 3, 4], "0,0,10,10"]) {
      const reading = parseStickerReading(answer({ box }));
      expect(reading.box).toBeNull();
      expect(reading.code).toBe("GNcrZRZ");
    }
  });

  test("throws on non-JSON", () => {
    expect(() => parseStickerReading("I cannot read this sticker")).toThrow();
    expect(() => parseStickerReading("")).toThrow();
  });
});

describe("resolveReadTime", () => {
  // Local times: the server runs with TZ=Europe/Amsterdam, tests only rely on local-time arithmetic
  const local = (day: number, hours: number, minutes: number) => new Date(2026, 9, day, hours, minutes, 0, 0);

  test("same day when the time is before the reference", () => {
    expect(resolveReadTime("11:17", local(17, 11, 40))).toEqual(local(17, 11, 17));
  });

  test("previous day across midnight", () => {
    expect(resolveReadTime("23:50", local(18, 0, 10))).toEqual(local(17, 23, 50));
  });

  test("up to 5 minutes in the future stays on the same day", () => {
    expect(resolveReadTime("11:45", local(17, 11, 40))).toEqual(local(17, 11, 45));
    expect(resolveReadTime("11:46", local(17, 11, 40))).toEqual(local(16, 11, 46));
  });
});
