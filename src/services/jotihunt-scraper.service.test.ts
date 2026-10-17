import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { Connection } from "mongoose";
import { initAppConfig, resetAppConfig, setPlain } from "../settings/app-config";

process.env.JOTIHUNT_WEB_URL = "https://jh.test";

const warnings: string[] = [];
const infos: string[] = [];
mock.module("../logger", () => ({ logger: { info: (message: string) => infos.push(message), debug() {}, error() {}, warn: (message: string) => warnings.push(message) } }));

// A fresh instance: another test file may have loaded the service already (before JOTIHUNT_WEB_URL was set,
// and resetAppConfig in the settings tests drops its config listener)
const freshService = "./jotihunt-scraper.service?fresh";
const { closeScraper, fetchPage, jotihuntLogin, LOGIN_BACKOFF_MS, scrapeHunts, setScraperFetch, testJotihuntLogin } = (await import(freshService)) as typeof import("./jotihunt-scraper.service");

const ROWS = `<table><thead><th>Deelgebied</th><th>Huntcode</th><th>Status</th><th>Punten</th><th>Hunttijd</th></thead><tbody><tr><td>Alpha</td><td>abc</td><td>Goedgekeurd</td><td>1</td><td>2026-10-17 12:00:00</td></tr></tbody></table>`;

/**
 * A fake jotihunt.nl: GET /login gives a form with a fresh CSRF token and a session cookie; POST /login with that
 * token and the right password logs the session in (302 to the dashboard, new session cookie), a wrong password 302s
 * back to /login, an old token answers 419. GET /hunts without a logged-in session 302s to /login.
 */
const site = {
  password: "hunter2",
  /** Sessions that are logged in */
  sessions: new Set<string>(),
  tokens: new Map<string, string>(),
  next: 0,
  /** Answer the next POST /login with 419 (the token went stale) */
  staleOnce: false,
  huntsHtml: ROWS,
  huntsStatus: 200,
  requests: [] as string[],
  reset() {
    this.sessions.clear();
    this.tokens.clear();
    this.next = 0;
    this.staleOnce = false;
    this.huntsHtml = ROWS;
    this.huntsStatus = 200;
    this.requests = [];
  },
};

function cookieOf(request: Request, name: string): string | null {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.get("cookie") ?? "");
  return match ? match[1] : null;
}

const redirect = (location: string, cookie?: string) => {
  const headers = new Headers({ location });
  if (cookie) headers.append("set-cookie", `jotihunt_app_session=${cookie}; path=/; secure; httponly`);
  return new Response("", { status: 302, headers });
};

async function fakeFetch(input: URL, init: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  expect(init.redirect).toBe("manual");
  const path = new URL(request.url).pathname;
  site.requests.push(`${request.method} ${path}`);
  const session = cookieOf(request, "jotihunt_app_session");
  if (path === "/login" && request.method === "GET") {
    if (session && site.sessions.has(session)) return redirect("https://jh.test/scoutingGroup/dashboard");
    const id = `s${++site.next}`;
    const token = `t${site.next}`;
    site.tokens.set(id, token);
    const headers = new Headers();
    headers.append("set-cookie", `jotihunt_app_session=${id}; path=/; secure; httponly`);
    headers.append("set-cookie", `XSRF-TOKEN=x${site.next}; path=/; secure`);
    return new Response(`<form method="POST"><input type="hidden" name="_token" value="${token}" autocomplete="off"><input name="email"></form>`, { status: 200, headers });
  }
  if (path === "/login" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    if (site.staleOnce || !session || site.tokens.get(session) !== form.get("_token")) {
      site.staleOnce = false;
      return new Response("Page Expired", { status: 419 });
    }
    if (form.get("password") !== site.password) return redirect("https://jh.test/login", session);
    const id = `s${++site.next}`;
    site.sessions.add(id);
    return redirect("https://jh.test/scoutingGroup/dashboard", id);
  }
  if (path === "/elders") return redirect("https://elsewhere.test/landing");
  if (path === "/scoutingGroup/dashboard") {
    if (!session || !site.sessions.has(session)) return redirect("https://jh.test/login");
    return new Response("<p>Dashboard</p>", { status: 200 });
  }
  if (path === "/hunts") {
    if (!session || !site.sessions.has(session)) return redirect("https://jh.test/login");
    return new Response(site.huntsHtml, { status: site.huntsStatus });
  }
  return new Response("Not found", { status: 404 });
}

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
const logins = () => site.requests.filter((entry) => entry === "POST /login").length;

beforeEach(async () => {
  await initAppConfig(fakeConnection(), ENV_LOGIN);
  site.reset();
  setScraperFetch(fakeFetch);
  warnings.length = 0;
  infos.length = 0;
});
afterEach(() => setSystemTime());
afterAll(() => {
  setScraperFetch(null);
  resetAppConfig();
});

describe("scrapeHunts", () => {
  test("logs in once and keeps the session between runs", async () => {
    expect(await scrapeHunts()).toMatchObject([{ siteKey: "code:abc", area: "alpha", status: "approved", location: null }]);
    await scrapeHunts();
    await scrapeHunts();
    expect(logins()).toBe(1);
    expect(site.requests.slice(-2)).toEqual(["GET /hunts", "GET /hunts"]);
  });

  test("an expired session (redirect to /login) logs in again and retries", async () => {
    await scrapeHunts();
    site.sessions.clear();
    expect(await scrapeHunts()).toHaveLength(1);
    expect(logins()).toBe(2);
  });

  test("a 419 on the login form fetches a fresh token and tries again", async () => {
    site.staleOnce = true;
    expect(await scrapeHunts()).toHaveLength(1);
    expect(site.requests.filter((entry) => entry === "GET /login")).toHaveLength(2);
  });

  test("wrong credentials fail with a login error", async () => {
    site.password = "other";
    try {
      await expect(scrapeHunts()).rejects.toThrow(/Login failed/);
    } finally {
      site.password = "hunter2";
    }
  });

  test("closeScraper forgets the session", async () => {
    await scrapeHunts();
    await closeScraper();
    await scrapeHunts();
    expect(logins()).toBe(2);
  });

  test("a Cloudflare or error page is no hunts page", async () => {
    site.huntsHtml = "<html><title>Just a moment...</title></html>";
    site.huntsStatus = 503;
    await expect(scrapeHunts()).rejects.toThrow(/No hunts page/);
  });

  test("another HTTP error fails the run", async () => {
    site.huntsHtml = "oops";
    site.huntsStatus = 500;
    await expect(scrapeHunts()).rejects.toThrow("GET /hunts → 500");
  });

  test("an unknown layout warns once per distinct warning", async () => {
    site.huntsHtml = "<main><p>Iets anders</p></main>";
    expect(await scrapeHunts()).toEqual([]);
    await scrapeHunts();
    expect(warnings).toEqual(["(SCRAPER) Unknown hunts layout (no tables)"]);
  });
});

describe("fetchPage", () => {
  test("shares the session with the hunt scrape", async () => {
    await scrapeHunts();
    expect(await fetchPage("/scoutingGroup/dashboard")).toEqual({ status: 200, html: "<p>Dashboard</p>" });
    expect(logins()).toBe(1);
    expect(site.requests.at(-1)).toBe("GET /scoutingGroup/dashboard");
  });

  test("an expired session logs in again and retries the page", async () => {
    await fetchPage("/scoutingGroup/dashboard");
    site.sessions.clear();
    expect((await fetchPage("/scoutingGroup/dashboard")).html).toBe("<p>Dashboard</p>");
    expect(logins()).toBe(2);
  });

  test("jobs that find no session at the same time share one login", async () => {
    const pages = await Promise.all([fetchPage("/scoutingGroup/dashboard"), fetchPage("/hunts"), fetchPage("/scoutingGroup/dashboard")]);
    expect(pages.map((page) => page.status)).toEqual([200, 200, 200]);
    expect(logins()).toBe(1);
  });

  test("returns other HTTP statuses as they are", async () => {
    expect(await fetchPage("/bericht/404")).toEqual({ status: 404, html: "Not found" });
  });

  test("wrong credentials fail with a login error", async () => {
    site.password = "other";
    try {
      await expect(fetchPage("/scoutingGroup/dashboard")).rejects.toThrow(/Login failed/);
    } finally {
      site.password = "hunter2";
    }
  });
});

describe("session safety", () => {
  test("cookies only go to the site; a redirect to another host is not followed", async () => {
    const hosts: [string, string | null][] = [];
    setScraperFetch(async (input, init) => {
      hosts.push([input.host, new Headers(init.headers).get("cookie")]);
      return fakeFetch(input, init);
    });
    expect(await fetchPage("/elders")).toEqual({ status: 302, html: "" });
    expect(hosts.every(([host]) => host === "jh.test")).toBe(true);
    expect(hosts.at(-1)![1]).toContain("jotihunt_app_session=");
  });

  test("the login e-mail is never logged", async () => {
    await fetchPage("/scoutingGroup/dashboard");
    expect(infos.join("\n")).not.toContain("team@example.nl");
    expect(infos).toContain("(SCRAPER) Logged in to Jotihunt website.");
  });

  test("closeScraper during a login: that login is not kept", async () => {
    const pending = fetchPage("/scoutingGroup/dashboard");
    await closeScraper();
    expect((await pending).status).toBe(200);
    await fetchPage("/scoutingGroup/dashboard");
    expect(logins()).toBe(2);
  });

  test("after a failed login the next waits 1, 2, 5, then 10 minutes; a success resets it", async () => {
    const start = Date.now();
    setSystemTime(start);
    site.password = "other";
    try {
      await expect(fetchPage("/hunts")).rejects.toThrow(/Login failed/);
      await expect(fetchPage("/hunts")).rejects.toThrow(/next try in 60 s/);
      expect(logins()).toBe(1);
      let at = start;
      for (const [index, wait] of LOGIN_BACKOFF_MS.entries()) {
        at += wait;
        setSystemTime(at);
        await expect(fetchPage("/hunts")).rejects.toThrow(/Login failed \(/);
        expect(logins()).toBe(index + 2);
        const next = LOGIN_BACKOFF_MS[Math.min(index + 1, LOGIN_BACKOFF_MS.length - 1)];
        await expect(fetchPage("/hunts")).rejects.toThrow(`next try in ${next / 1000} s`);
      }
      site.password = "hunter2";
      at += LOGIN_BACKOFF_MS.at(-1)!;
      setSystemTime(at);
      expect((await fetchPage("/hunts")).status).toBe(200);
      site.sessions.clear();
      site.password = "other";
      await expect(fetchPage("/hunts")).rejects.toThrow(/Login failed \(/);
      await expect(fetchPage("/hunts")).rejects.toThrow("next try in 60 s");
    } finally {
      site.password = "hunter2";
    }
  });

  test("a changed login ends the wait", async () => {
    site.password = "other";
    try {
      await expect(fetchPage("/hunts")).rejects.toThrow(/Login failed \(/);
      site.password = "hunter2";
      await setPlain({ jotihuntWebUsername: "other@example.nl" }, "test");
      await Bun.sleep(0);
      expect((await fetchPage("/hunts")).status).toBe(200);
    } finally {
      site.password = "hunter2";
    }
  });
});

describe("Jotihunt website login", () => {
  test("comes from the app config and is null when incomplete", async () => {
    expect(jotihuntLogin()).toEqual({ username: "team@example.nl", password: "hunter2" });
    await initAppConfig(fakeConnection(), { JOTIHUNT_WEB_USERNAME: "team@example.nl" });
    expect(jotihuntLogin()).toBeNull();
  });

  test("a changed login drops the kept session", async () => {
    await scrapeHunts();
    await setPlain({ jotihuntWebUsername: "other@example.nl" }, "test");
    await Bun.sleep(0);
    await scrapeHunts();
    expect(logins()).toBe(2);
  });

  test("another secrets change keeps the session", async () => {
    await scrapeHunts();
    await setPlain({ telegramApiId: "12345" }, "test");
    await Bun.sleep(0);
    await scrapeHunts();
    expect(logins()).toBe(1);
  });

  test("test-login tries the given login in its own session; the kept one stays", async () => {
    await scrapeHunts();
    expect(await testJotihuntLogin({ username: "new@example.nl", password: "hunter2" })).toEqual({ ok: true });
    await scrapeHunts();
    expect(logins()).toBe(2);
    expect(site.requests.at(-1)).toBe("GET /hunts");
    expect(site.requests.at(-2)).not.toBe("POST /login");
  });

  test("test-login reports wrong credentials", async () => {
    expect(await testJotihuntLogin({ username: "team@example.nl", password: "wrong" })).toEqual({ ok: false, error: "Inloggen mislukt: controleer gebruikersnaam en wachtwoord." });
  });

  test("test-login without a login fails before any request", async () => {
    await initAppConfig(fakeConnection(), {});
    expect(await testJotihuntLogin()).toEqual({ ok: false, error: "Vul gebruikersnaam en wachtwoord in." });
    expect(site.requests).toEqual([]);
  });
});
