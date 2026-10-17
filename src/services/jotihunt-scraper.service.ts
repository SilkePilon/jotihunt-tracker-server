import { logger } from "../logger";
import { onAppConfigChange, plain, secret } from "../settings/app-config";
import { parseHuntsPage, type ScrapedHunt } from "./jotihunt-hunts.parse";

const websiteUrl = process.env.JOTIHUNT_WEB_URL as string;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

/** One request (each redirect hop included) may take this long */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Redirects followed per request at most */
const MAX_REDIRECTS = 5;

/** The site login (Beheer → Algemeen, else JOTIHUNT_WEB_USERNAME/PASSWORD); null when incomplete */
export function jotihuntLogin(): { username: string; password: string } | null {
  const username = plain("jotihuntWebUsername");
  const password = secret("jotihuntWebPassword");
  return username && password ? { username, password } : null;
}

/** Cookies by name for the one site we talk to (domain and path are ignored: everything is jotihunt.nl at /) */
type CookieJar = Map<string, string>;

/**
 * The logged-in session (Laravel's session + XSRF cookies), kept between scraper runs so a run is one GET /hunts.
 * Empty: log in first.
 */
let jar: CookieJar = new Map();
/** The login the kept session used (JSON), to tell a changed login from other secret changes */
let lastLogin: string | null = null;
let lastWarning: string | null = null;

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** fetch, replaced in tests */
let fetchImpl: Fetch = (input, init) => fetch(input, init);

function storeCookies(cookies: CookieJar, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some((attribute) => {
      const [key, raw = ""] = attribute.split("=");
      const lower = key.trim().toLowerCase();
      return (lower === "max-age" && Number(raw) <= 0) || (lower === "expires" && Date.parse(raw) < Date.now());
    });
    if (expired || value === "") cookies.delete(name);
    else cookies.set(name, value);
  }
}

const cookieHeader = (cookies: CookieJar) => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

/**
 * One request with the jar's cookies, following redirects by hand (every hop's Set-Cookie is kept: the login's 302
 * carries the new session). Returns the last response and the URL it came from.
 */
async function request(cookies: CookieJar, path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<{ response: Response; url: URL }> {
  let url = new URL(path, websiteUrl);
  let method = init.method ?? "GET";
  let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" };
    if (cookies.size > 0) headers.Cookie = cookieHeader(cookies);
    if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetchImpl(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    storeCookies(cookies, response);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return { response, url };
    if (hop >= MAX_REDIRECTS) throw new Error(`${method} ${url.pathname}: too many redirects`);
    // Drain the redirect body so the connection can be reused
    await response.arrayBuffer().catch(() => undefined);
    url = new URL(location, url);
    // A 302/303 after a POST is a GET (like a browser)
    if (response.status !== 307 && response.status !== 308) {
      method = "GET";
      body = undefined;
    }
  }
}

const isLoginPage = (url: URL) => /\/login\/?$/.test(url.pathname);

/** The CSRF token of the login form (attributes in any order) */
function csrfToken(html: string): string | null {
  for (const input of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']_token["']/i.test(input)) continue;
    return /\bvalue\s*=\s*["']([^"']*)["']/i.exec(input)?.[1] ?? null;
  }
  return null;
}

/**
 * Log in with a fresh CSRF token: GET /login (form + session cookies), POST the form. Success is a redirect away from
 * /login (to the dashboard); back on /login means wrong credentials. A 419 (stale token) is retried once with a new
 * token. Throws "Login failed…" otherwise.
 */
async function logIn(cookies: CookieJar, login = jotihuntLogin()): Promise<void> {
  if (!login) throw new Error("No Jotihunt website login set");
  logger.info("(SCRAPER) Logging in to Jotihunt website with e-mail: " + login.username);
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = await request(cookies, "/login");
    // Still logged in: the site sends a guest away from /login
    if (form.response.ok && !isLoginPage(form.url)) return;
    const token = csrfToken(await form.response.text());
    if (!form.response.ok || !token) throw new Error(`Login failed: no login form (GET /login → ${form.response.status})`);
    const { response, url } = await request(cookies, "/login", { method: "POST", form: { _token: token, email: login.username, password: login.password } });
    if (response.status === 419) {
      cookies.clear();
      continue;
    }
    await response.arrayBuffer().catch(() => undefined);
    if (isLoginPage(url) || !response.ok) {
      logger.error("(SCRAPER) Login failed, check your credentials.");
      throw new Error(`Login failed (POST /login → ${isLoginPage(url) ? "back to /login" : response.status})`);
    }
    logger.info("(SCRAPER) Logged in to Jotihunt website.");
    return;
  }
  throw new Error("Login failed: the login form kept expiring (419)");
}

/** Forget the kept session; the next scrape logs in again. */
export async function closeScraper(): Promise<void> {
  jar = new Map();
}

// A changed login applies at the next scrape: drop the session (other secret changes leave it alone)
onAppConfigChange((part) => {
  if (part !== "secrets" || jar.size === 0 || JSON.stringify(jotihuntLogin()) === lastLogin) return;
  void closeScraper();
});

/** Try a login in a separate session (Beheer → "Inloggen testen"); the kept session is not touched. */
export async function testJotihuntLogin(login = jotihuntLogin()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!websiteUrl) return { ok: false, error: "JOTIHUNT_WEB_URL is niet ingesteld op de server." };
  if (!login) return { ok: false, error: "Vul gebruikersnaam en wachtwoord in." };
  try {
    await logIn(new Map(), login);
    return { ok: true };
  } catch {
    return { ok: false, error: "Inloggen mislukt: controleer gebruikersnaam en wachtwoord." };
  }
}

/** Signs that a page did not load: a Cloudflare challenge or a server error page */
const NOT_THE_HUNTS_PAGE = /just a moment|cf-challenge|challenge-platform|captcha|502 bad gateway|503 service|server error/i;

/** Bumped by every fresh login, so a request that lost its session to another job's login just retries */
let loginGeneration = 0;
/** The login in progress: jobs that find the session gone at the same time share one login */
let loginInFlight: Promise<void> | null = null;

/** Start from a new jar and log in (one login at a time for every job) */
function freshLogin(): Promise<void> {
  loginInFlight ??= (async () => {
    jar = new Map();
    loginGeneration++;
    const login = jotihuntLogin();
    lastLogin = JSON.stringify(login);
    await logIn(jar, login);
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

/** GET a page with the kept session; null when the session is gone (sent to /login, or a 419) */
async function sessionPage(path: string): Promise<{ status: number; html: string } | null> {
  const { response, url } = await request(jar, path);
  if (isLoginPage(url) || response.status === 419) {
    await response.arrayBuffer().catch(() => undefined);
    return null;
  }
  return { status: response.status, html: await response.text() };
}

/**
 * GET a logged-in page of jotihunt.nl with the one shared session (hunts, score and assignments use the same jar),
 * logging in first when there is no session and again when it expired. Any HTTP status is returned as-is; throws
 * "Login failed…" when logging in does not help.
 */
export async function fetchPage(path: string): Promise<{ status: number; html: string }> {
  if (loginInFlight) await loginInFlight.catch(() => undefined);
  const generation = loginGeneration;
  let page = jar.size > 0 ? await sessionPage(path) : null;
  if (page !== null) return page;
  // Another job logged in meanwhile: its session may work for us too
  if (generation !== loginGeneration && jar.size > 0) page = await sessionPage(path);
  if (page !== null) return page;
  await freshLogin();
  page = await sessionPage(path);
  if (page === null) throw new Error(`Login failed: ${path} still asks to log in`);
  return page;
}

/**
 * Scrape the hunts from the logged-in /hunts page with plain HTTP (see fetchPage for the session). The HTML is parsed
 * by jotihunt-hunts.parse (tested against saved pages).
 */
export async function scrapeHunts(): Promise<ScrapedHunt[]> {
  logger.debug("(SCRAPER) Scraping hunts from Jotihunt website...");
  const { status, html } = await fetchPage("/hunts");
  if ((status < 200 || status >= 300) && !NOT_THE_HUNTS_PAGE.test(html)) throw new Error(`GET /hunts → ${status}`);

  const { hunts, warning, found } = parseHuntsPage(html);
  if (!found && NOT_THE_HUNTS_PAGE.test(html)) throw new Error("No hunts page (Cloudflare or server error)");
  // Once per distinct warning: the cron runs every minute
  if (warning && warning !== lastWarning) logger.warn(`(SCRAPER) ${warning}`);
  lastWarning = warning;
  logger.debug(`(SCRAPER) Found ${hunts.length} hunts from website.`);
  return hunts;
}

/** True when the HTML is a Cloudflare challenge or a server error page rather than the site's own page */
export const isNotASitePage = (html: string) => NOT_THE_HUNTS_PAGE.test(html);

/** For tests: a fake fetch (null restores the real one); also forgets the session and the last warning */
export function setScraperFetch(fake: Fetch | null): void {
  fetchImpl = fake ?? ((input, init) => fetch(input, init));
  jar = new Map();
  loginInFlight = null;
  lastWarning = null;
}
