import { describe, expect, test } from "bun:test";
import { deviceLabel } from "./user-agent";

describe("deviceLabel", () => {
  test.each([
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox op Linux"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36", "Chrome op Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "Safari op iPhone"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0", "Edge op Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15", "Safari op macOS"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "Samsung Internet op Android"],
  ])("%s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  test("unknown or missing user agent", () => {
    expect(deviceLabel(undefined)).toBe("Onbekend apparaat");
    expect(deviceLabel("curl/8.0")).toBe("Onbekend apparaat");
  });
});
