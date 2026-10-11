import { describe, expect, test } from "bun:test";
import { parseTrustProxy } from "./trust-proxy";

describe("parseTrustProxy", () => {
  test("booleans", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });
  test("hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
  });
  test("subnet lists stay strings", () => {
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).toBe("loopback, 10.0.0.0/8");
  });
});
