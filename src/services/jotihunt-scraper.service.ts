import puppeteer, { Page } from "puppeteer";
import { logger } from "../logger";
import { onAppConfigChange, plain, secret } from "../settings/app-config";
import { extractHuntsPage, parseHuntDetail, parseHuntsPage, type ParsedLocation, type ScrapedHunt } from "./jotihunt-hunts.parse";

const websiteUrl = process.env.JOTIHUNT_WEB_URL as string;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

/** One browser with a logged-in page, kept between scraper runs (launching Chromium and logging in every minute is heavy). */
let session: Promise<Page> | undefined;
/** The login the kept browser used (JSON), to tell a changed login from other secret changes */
let lastLogin: string | null = null;

/** The site login (Beheer → Algemeen, else JOTIHUNT_WEB_USERNAME/PASSWORD); null when incomplete */
export function jotihuntLogin(): { username: string; password: string } | null {
  const username = plain("jotihuntWebUsername");
  const password = secret("jotihuntWebPassword");
  return username && password ? { username, password } : null;
}

async function logIn(page: Page, login = jotihuntLogin()): Promise<void> {
  if (!login) throw new Error("No Jotihunt website login set");
  logger.info("(SCRAPER) Logging in to Jotihunt website with e-mail: " + login.username);
  await page.goto(websiteUrl + "/login", { waitUntil: "networkidle2" });
  await page.type('input[name="email"]', login.username);
  await page.type('input[name="password"]', login.password);
  await Promise.all([page.click("button.btn"), page.waitForNavigation({ waitUntil: "networkidle2" })]);

  if (page.url().endsWith("/login")) {
    logger.error("(SCRAPER) Login failed, check your credentials.");
    throw new Error("Login failed");
  }
  logger.info("(SCRAPER) Logged in to Jotihunt website.");
}

function launchBrowser() {
  // Prefer an explicit PUPPETEER_EXECUTABLE_PATH (set in the Docker image to the system chromium),
  // fall back to the system chromium in production and to puppeteer's bundled browser otherwise.
  const isProduction = process.env.NODE_ENV === "production";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isProduction ? "/usr/bin/chromium" : undefined);
  return puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    ...(executablePath && { executablePath }),
  });
}

async function launch(): Promise<Page> {
  const browser = await launchBrowser();
  browser.once("disconnected", () => {
    session = undefined;
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent({ userAgent });
    const login = jotihuntLogin();
    lastLogin = JSON.stringify(login);
    await logIn(page, login);
    return page;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** The kept logged-in page, launching the browser (and logging in) when there is none or it died. */
async function scraperPage(): Promise<Page> {
  const current = await session?.catch(() => undefined);
  if (current && current.browser().connected && !current.isClosed()) return current;

  const next = launch();
  session = next;
  next.catch(() => {
    if (session === next) session = undefined;
  });
  return next;
}

/** Close the kept browser; the next scrape starts a fresh one. */
export async function closeScraper(): Promise<void> {
  const current = session;
  session = undefined;
  const page = await current?.catch(() => undefined);
  await page?.browser().close().catch(() => undefined);
}

// A changed login applies at the next scrape: close the logged-in browser (other secrets leave it alone)
onAppConfigChange((part) => {
  if (part !== "secrets" || !session || JSON.stringify(jotihuntLogin()) === lastLogin) return;
  void closeScraper();
});

/** Try a login in a fresh browser (Beheer → "Inloggen testen"); closes it afterwards. */
export async function testJotihuntLogin(login = jotihuntLogin()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!websiteUrl) return { ok: false, error: "JOTIHUNT_WEB_URL is niet ingesteld op de server." };
  if (!login) return { ok: false, error: "Vul gebruikersnaam en wachtwoord in." };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent({ userAgent });
    await logIn(page, login);
    return { ok: true };
  } catch {
    return { ok: false, error: "Inloggen mislukt: controleer gebruikersnaam en wachtwoord." };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Signs that /hunts did not load: a Cloudflare challenge or a server error page */
const NOT_THE_HUNTS_PAGE = /just a moment|cf-challenge|challenge-platform|captcha|502 bad gateway|503 service|server error/i;

/**
 * Scrape the hunts from the logged-in /hunts page, logging in again when the session expired. The page HTML is parsed
 * in Node (jotihunt-hunts.parse) so the parser can be tested against saved pages.
 */
export async function scrapeHunts(): Promise<ScrapedHunt[]> {
  logger.debug("(SCRAPER) Scraping hunts from Jotihunt website...");
  const page = await scraperPage();

  await page.goto(websiteUrl + "/hunts", { waitUntil: "networkidle2" });
  if (page.url().endsWith("/login")) {
    // The website session expired: log in on the same page and try once more
    await logIn(page);
    await page.goto(websiteUrl + "/hunts", { waitUntil: "networkidle2" });
  }

  const html = await page.content();
  const raw = extractHuntsPage(html);
  if (raw.rows.length === 0 && raw.headers.length === 0 && NOT_THE_HUNTS_PAGE.test(html)) throw new Error(`No hunts page on ${page.url()}`);
  const { hunts, warning } = parseHuntsPage(raw);
  if (warning) {
    // Once per distinct warning: the cron runs every minute
    if (warning !== lastWarning) logger.warn(`(SCRAPER) ${warning}`);
  }
  lastWarning = warning;

  await addDetails(page, hunts);
  logger.debug(`(SCRAPER) Found ${hunts.length} hunts from website.`);
  return hunts;
}

let lastWarning: string | null = null;

/** Detail pages opened per run at most (each takes a page load) */
export const MAX_DETAIL_PAGES = 5;
/** A detail page without a location is opened again after this long */
const DETAIL_RETRY_MS = 5 * 60 * 1000;
/** What a detail page gave, by its URL; a page with a location is not opened again */
const details = new Map<string, { location: ParsedLocation | null; qrCode: string | null; at: number }>();

/**
 * Hunts whose list row has no location get it (and their QR code) from their own page, when the list links one. At most
 * MAX_DETAIL_PAGES pages per run; a failing page is skipped. The siteKey stays the list page's.
 */
async function addDetails(page: Page, hunts: ScrapedHunt[], now = Date.now()): Promise<void> {
  let opened = 0;
  for (const hunt of hunts) {
    if (hunt.location || !hunt.detailUrl) continue;
    const url = new URL(hunt.detailUrl, websiteUrl + "/hunts").href;
    let found = details.get(url);
    if (!found || (!found.location && now - found.at > DETAIL_RETRY_MS)) {
      if (opened >= MAX_DETAIL_PAGES) continue;
      opened++;
      try {
        await page.goto(url, { waitUntil: "networkidle2" });
        found = { ...parseHuntDetail(await page.content()), at: now };
        details.set(url, found);
      } catch (error) {
        logger.warn(`(SCRAPER) Could not read hunt page ${url}:`, error);
        continue;
      }
    }
    hunt.location = found.location;
    hunt.qrCode ??= found.qrCode;
  }
}

/** For tests */
export function forgetHuntDetails(): void {
  details.clear();
  lastWarning = null;
}
