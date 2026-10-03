import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.JOTIHUNT_WEB_URL = "https://jh.test";

let launches = 0;
let logins = 0;
/** URL the next goto("/hunts") lands on; "/login" simulates an expired website session */
let huntsRedirect: string | null = null;

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
      url = "https://jh.test/dashboard";
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

const { closeScraper, scrapeHunts } = await import("./jotihunt-scraper.service");

beforeEach(async () => {
  await closeScraper();
  launches = 0;
  logins = 0;
  huntsRedirect = null;
});

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
