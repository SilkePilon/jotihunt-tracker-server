import { describe, expect, test } from "bun:test";
import { approxLocation } from "./location";

const headers = (values: Record<string, string>) => (name: string) => values[name];

describe("approxLocation", () => {
  test("city first, else the Dutch country name, else null", () => {
    expect(approxLocation(headers({ "cf-ipcity": "Arnhem", "cf-ipcountry": "NL" }), true)).toBe("Arnhem");
    expect(approxLocation(headers({ "cf-ipcountry": "NL" }), true)).toBe("Nederland");
    expect(approxLocation(headers({ "cf-ipcountry": "be" }), true)).toBe("België");
    expect(approxLocation(headers({}), true)).toBeNull();
  });

  test("Cloudflare's unknown (XX) and Tor (T1) codes, unassigned codes and junk are null", () => {
    expect(approxLocation(headers({ "cf-ipcountry": "XX" }), true)).toBeNull();
    expect(approxLocation(headers({ "cf-ipcountry": "T1" }), true)).toBeNull();
    expect(approxLocation(headers({ "cf-ipcountry": "QQ" }), true)).toBeNull();
    expect(approxLocation(headers({ "cf-ipcountry": "Nederland" }), true)).toBeNull();
  });

  test("not behind Cloudflare the headers are ignored (they could be forged)", () => {
    expect(approxLocation(headers({ "cf-ipcity": "Arnhem", "cf-ipcountry": "NL" }), false)).toBeNull();
  });
});
