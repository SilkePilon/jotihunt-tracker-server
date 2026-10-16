import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Connection } from "mongoose";
import { initAppConfig, resetAppConfig } from "../settings/app-config";

// websiteUrl is read when the module loads: set it before the (dynamic) import. Bun shares the module
// cache between test files, so when another file loaded the service first the URL may still be unset.
process.env.JOTIHUNT_WEB_URL ||= "https://jotihunt.example";
const { jotihuntLogin, testJotihuntLogin } = await import("./jotihunt-scraper.service");
const NOT_CONFIGURED = ["Vul gebruikersnaam en wachtwoord in.", "JOTIHUNT_WEB_URL is niet ingesteld op de server."];

// No settings document and an empty env: no login anywhere
const emptyConnection = { collection: () => ({ findOne: async () => null }) } as unknown as Connection;

beforeAll(() => initAppConfig(emptyConnection, {}));
afterAll(resetAppConfig);

describe("Jotihunt website login", () => {
  test("is null without a username and password", () => {
    expect(jotihuntLogin()).toBeNull();
  });

  test("test-login without a login fails before launching a browser", async () => {
    const result = await testJotihuntLogin();
    expect(result.ok).toBe(false);
    expect(NOT_CONFIGURED).toContain(result.ok ? "" : result.error);
  });
});
