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
const TABLE = "<table><tr><th>Deelgebied</th><th>Huntcode</th><th>Status</th><th>Punten</th><th>Tijdstip</th></tr><tr><td>Alpha</td><td>abc</td><td>ok</td><td>1</td><td>12:00</td></tr></table>";
/** HTML per page path; /hunts defaults to TABLE */
let pages: Record<string, string> = {};
/** Every page opened */
let visited: string[] = [];
/** Paths whose page load never finishes */
let hanging = new Set<string>();

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
      visited.push(target);
      if (hanging.has(new URL(target).pathname)) await new Promise(() => {});
      url = target.endsWith("/hunts") && huntsRedirect ? huntsRedirect : target;
      huntsRedirect = null;
    },
    url: () => url,
    content: async () => {
      const path = new URL(url).pathname;
      return pages[path] ?? (path === "/hunts" ? TABLE : "<p>Niet gevonden</p>");
    },
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
const { closeScraper, forgetHuntDetails, jotihuntLogin, scrapeHunts, setDetailTimeouts, testJotihuntLogin } = (await import(freshService)) as typeof import("./jotihunt-scraper.service");

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
  pages = {};
  visited = [];
  hanging = new Set();
  forgetHuntDetails();
  setDetailTimeouts({ pageMs: 50, budgetMs: 1_000 });
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

describe("hunt detail pages", () => {
  const card = (id: number, area: string, attrs = "") => `<div class="hunt" ${attrs}><h3>Vossenteam ${area}</h3><p>Tijd: 21:${String(id % 60).padStart(2, "0")}</p><a href="/hunts/${id}">Details</a></div>`;
  const detail = (lat: number) => `<main><dl><dt>QR-code</dt><dd>Q${lat}</dd><dt>Locatie</dt><dd>${lat}, 5.65</dd><dt>Nauwkeurigheid</dt><dd>9 m</dd></dl></main>`;

  test("a hunt without a location gets it (and its QR code) from its own page; the key stays", async () => {
    pages["/hunts"] = `<main>${card(1, "Alpha", 'data-lat="52.01" data-lng="5.98"')}${card(2, "Bravo")}</main>`;
    pages["/hunts/2"] = detail(52.05);
    const hunts = await scrapeHunts();
    expect(hunts[0]).toMatchObject({ siteKey: "id:1", location: { lat: 52.01, lng: 5.98, accuracy: null } });
    expect(hunts[1]).toMatchObject({ siteKey: "id:2", qrCode: null, detailQrCode: "Q52.05", location: { lat: 52.05, lng: 5.65, accuracy: 9 } });
    expect(visited.filter((target) => target.includes("/hunts/"))).toEqual(["https://jh.test/hunts/2"]);
  });

  test("at most 5 detail pages per run; a page with a location is not opened again", async () => {
    pages["/hunts"] = `<main>${[1, 2, 3, 4, 5, 6, 7].map((id) => card(id, "Charlie")).join("")}</main>`;
    for (const id of [1, 2, 3, 4, 5, 6, 7]) pages[`/hunts/${id}`] = detail(52 + id / 100);
    const first = await scrapeHunts();
    expect(first.filter((hunt) => hunt.location)).toHaveLength(5);
    visited = [];
    const second = await scrapeHunts();
    expect(second.filter((hunt) => hunt.location)).toHaveLength(7);
    expect(visited.filter((target) => target.includes("/hunts/"))).toEqual(["https://jh.test/hunts/6", "https://jh.test/hunts/7"]);
  });
});

describe("hunt detail pages that fail", () => {
  const card = (id: number) => `<div class="hunt"><h3>Vossenteam Delta</h3><p>Tijd: 20:0${id}</p><a href="/hunts/${id}">Details</a></div>`;

  test("a hanging page times out; the list (and the other pages) still come through; the failure is not retried at once", async () => {
    pages["/hunts"] = `<main>${card(1)}${card(2)}</main>`;
    pages["/hunts/2"] = "<main><dl><dt>Locatie</dt><dd>52.05, 5.65</dd></dl></main>";
    hanging.add("/hunts/1");
    const hunts = await scrapeHunts();
    expect(hunts.map((hunt) => [hunt.siteKey, hunt.location?.lat ?? null])).toEqual([
      ["id:1", null],
      ["id:2", 52.05],
    ]);
    visited = [];
    await scrapeHunts();
    expect(visited.filter((target) => target.includes("/hunts/"))).toEqual([]);
  });

  test("the detail budget stops opening pages", async () => {
    setDetailTimeouts({ pageMs: 50, budgetMs: 60 });
    pages["/hunts"] = `<main>${[1, 2, 3, 4].map(card).join("")}</main>`;
    for (const id of [1, 2, 3, 4]) hanging.add(`/hunts/${id}`);
    await scrapeHunts();
    expect(visited.filter((target) => target.includes("/hunts/")).length).toBeLessThanOrEqual(2);
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
