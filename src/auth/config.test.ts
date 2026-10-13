import { describe, expect, test } from "bun:test";
import { groupConfig, publicAppUrl, webauthnConfig } from "./config";

describe("webauthnConfig", () => {
  test("reads rp id, name and a comma separated origin list", () => {
    expect(webauthnConfig({ WEBAUTHN_RP_ID: "jotihunt.example", WEBAUTHN_ORIGINS: "https://jotihunt.example, http://localhost:5173 ", WEBAUTHN_RP_NAME: "JH" })).toEqual({
      rpId: "jotihunt.example",
      rpName: "JH",
      origins: ["https://jotihunt.example", "http://localhost:5173"],
    });
  });

  test("rp name defaults to Jotihunt Tracker", () => {
    expect(webauthnConfig({ WEBAUTHN_RP_ID: "a", WEBAUTHN_ORIGINS: "https://a" }).rpName).toBe("Jotihunt Tracker");
  });

  test("missing rp id or origins throws", () => {
    expect(() => webauthnConfig({ WEBAUTHN_ORIGINS: "https://a" })).toThrow("WEBAUTHN_RP_ID is not set");
    expect(() => webauthnConfig({ WEBAUTHN_RP_ID: "a", WEBAUTHN_ORIGINS: " , " })).toThrow("WEBAUTHN_ORIGINS is not set");
  });
});

describe("publicAppUrl", () => {
  test("strips trailing slashes", () => {
    expect(publicAppUrl({ PUBLIC_APP_URL: "https://jotihunt.example//" })).toBe("https://jotihunt.example");
  });
  test("missing throws", () => {
    expect(() => publicAppUrl({})).toThrow("PUBLIC_APP_URL is not set");
  });
});

describe("groupConfig", () => {
  test("parses the home team id and group name", () => {
    expect(groupConfig({ HOME_TEAM_API_ID: "66", GROUP_NAME: " Scouting De Bever " })).toEqual({ homeTeamApiId: 66, groupName: "Scouting De Bever" });
  });
  test("missing or invalid values are null", () => {
    expect(groupConfig({ HOME_TEAM_API_ID: "abc" })).toEqual({ homeTeamApiId: null, groupName: null });
  });
});
