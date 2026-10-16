import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Connection } from "mongoose";
import { initAppConfig, resetAppConfig, setPlain } from "../settings/app-config";

process.env.JOTIHUNT_WEB_URL = "https://jh.test";

let launches = 0;
let logins = 0;
let closes = 0;
/** URL the next goto("/hunts") lands on; "/login" simulates an expired website session */
let huntsRedirect: string | null = null;
/** When set, submitting the login form stays on /login (wrong credentials) */
let rejectLogin = false;

function fakeBrowser() {
  let connected = true;
  let url = "";
  const page = {
    isClosed: () => false,
    browser: () => browser,
    setUserAgent: async () => {},
    type: async () => {},
    click: async () => {},
    waitForNavigation: async () => {
      logins++;
      url = rejectLogin ? "https://jh.test/login" : "https://jh.test/dashboard";
    },
    goto: async (target: string) => {
      url = target.endsWith("/hunts") && huntsRedirect ? huntsRedirect : target;
      huntsRedirect = null;
    },
    url: () => url,
    evaluate: async () => [{ area: "Alpha", huntCode: "abc", status: "ok", points: 1, huntTime: "12:00" }],
  };
  const browser = {
    get connected() {
      return connected;
    },
    once: () => {},
    newPage: async () => page,
    close: async () => {
      connected = false;
      closes++;
    },
  };
  return browser;
}

mock.module("puppeteer", () => ({
  default: {
    launch: async () => {
      launches++;
      return fakeBrowser();
    },
  },
}));
mock.module("../logger", () => ({ logger: { info() {}, debug() {}, error() {}, warn() {} } }));

// A fresh instance: another test file may have loaded the service already (before JOTIHUNT_WEB_URL was set,
// and resetAppConfig in the settings tests drops its config listener)
const freshService = "./jotihunt-scraper.service?fresh";
const { closeScraper, jotihuntLogin, scrapeHunts, testJotihuntLogin } = (await import(freshService)) as typeof import("./jotihunt-scraper.service");

/** A settings collection with only the plain username stored; the env holds the login */
function fakeConnection(): Connection {
  let stored: Record<string, unknown> | null = null;
  const collection = {
    findOne: async () => stored,
    updateOne: async (_filter: unknown, update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
      stored = { key: "app-config", secrets: { plain: { jotihuntWebUsername: update.$set?.["secrets.plain.jotihuntWebUsername"] } } };
    },
  };
  return { collection: () => collection } as unknown as Connection;
}
const ENV_LOGIN = { JOTIHUNT_WEB_USERNAME: "team@example.nl", JOTIHUNT_WEB_PASSWORD: "hunter2" };

beforeEach(async () => {
  await initAppConfig(fakeConnection(), ENV_LOGIN);
  await closeScraper();
  launches = 0;
  logins = 0;
  closes = 0;
  huntsRedirect = null;
  rejectLogin = false;
});
afterAll(resetAppConfig);

describe("scrapeHunts", () => {
  test("keeps one logged-in browser between runs", async () => {
    expect(await scrapeHunts()).toHaveLength(1);
    await scrapeHunts();
    await scrapeHunts();
    expect(launches).toBe(1);
    expect(logins).toBe(1);
  });

  test("logs in again on the same browser when the website session expired", async () => {
    await scrapeHunts();
    huntsRedirect = "https://jh.test/login";
    expect(await scrapeHunts()).toHaveLength(1);
    expect(launches).toBe(1);
    expect(logins).toBe(2);
  });

  test("starts a fresh browser after closeScraper", async () => {
    await scrapeHunts();
    await closeScraper();
    await scrapeHunts();
    expect(launches).toBe(2);
  });
});

describe("Jotihunt website login", () => {
  test("comes from the app config and is null when incomplete", async () => {
    expect(jotihuntLogin()).toEqual({ username: "team@example.nl", password: "hunter2" });
    await initAppConfig(fakeConnection(), { JOTIHUNT_WEB_USERNAME: "team@example.nl" });
    expect(jotihuntLogin()).toBeNull();
  });

  test("a changed login closes the kept browser", async () => {
    await scrapeHunts();
    await setPlain({ jotihuntWebUsername: "other@example.nl" }, "test");
    await Bun.sleep(0);
    expect(closes).toBe(1);
    await scrapeHunts();
    expect(launches).toBe(2);
  });

  test("another secrets change keeps the logged-in browser", async () => {
    await scrapeHunts();
    await setPlain({ telegramApiId: "12345" }, "test");
    await Bun.sleep(0);
    expect(closes).toBe(0);
    await scrapeHunts();
    expect(launches).toBe(1);
  });

  test("test-login tries the given login in a fresh browser and closes it", async () => {
    await scrapeHunts();
    expect(await testJotihuntLogin({ username: "new@example.nl", password: "pw" })).toEqual({ ok: true });
    expect(launches).toBe(2);
    expect(closes).toBe(1);
  });

  test("test-login reports wrong credentials", async () => {
    rejectLogin = true;
    expect(await testJotihuntLogin()).toEqual({ ok: false, error: "Inloggen mislukt: controleer gebruikersnaam en wachtwoord." });
    expect(closes).toBe(1);
  });

  test("test-login without a login fails before launching a browser", async () => {
    await initAppConfig(fakeConnection(), {});
    expect(await testJotihuntLogin()).toEqual({ ok: false, error: "Vul gebruikersnaam en wachtwoord in." });
    expect(launches).toBe(0);
  });
});
