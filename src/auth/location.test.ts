import { describe, expect, test } from "bun:test";
import { approxLocation } from "./location";

const headers = (values: Record<string, string>) => (name: string) => values[name];

describe("approxLocation", () => {
  test("city first, else the Dutch country name, else null", () => {
    expect(approxLocation(headers({ "cf-ipcity": "Arnhem", "cf-ipcountry": "NL" }))).toBe("Arnhem");
    expect(approxLocation(headers({ "cf-ipcountry": "NL" }))).toBe("Nederland");
    expect(approxLocation(headers({ "cf-ipcountry": "be" }))).toBe("België");
    expect(approxLocation(headers({}))).toBeNull();
  });

  test("Cloudflare's unknown (XX) and Tor (T1) codes and junk are null", () => {
    expect(approxLocation(headers({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(approxLocation(headers({ "cf-ipcountry": "T1" }))).toBeNull();
    expect(approxLocation(headers({ "cf-ipcountry": "Nederland" }))).toBeNull();
  });
});
