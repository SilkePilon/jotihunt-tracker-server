import puppeteer, { Page } from "puppeteer";
import { logger } from "../logger";
import { onAppConfigChange, plain, secret } from "../settings/app-config";
import { WebHunt } from "../types/api";
import { parseHuntsTable } from "./jotihunt-hunts.parse";

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

/**
 * Scrape the last 15 hunts from the Jotihunt website, logging in again when the session expired.
 */
export async function scrapeHunts(): Promise<WebHunt[]> {
  logger.debug("(SCRAPER) Scraping hunts from Jotihunt website...");
  const page = await scraperPage();

  await page.goto(websiteUrl + "/hunts", { waitUntil: "networkidle2" });
  if (page.url().endsWith("/login")) {
    // The website session expired: log in on the same page and try once more
    await logIn(page);
    await page.goto(websiteUrl + "/hunts", { waitUntil: "networkidle2" });
  }

  const table = await page.evaluate(() => {
    // No table at all: not the hunts page (e.g. a Cloudflare challenge or an error page)
    const element = document.querySelector("table");
    if (!element) return null;
    // No helper functions in here: the callback is serialised into the page as is
    const headerRow = element.querySelector("thead tr") ?? element.querySelector("tr");
    const headers = headerRow ? Array.from(headerRow.querySelectorAll("th"), (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()) : [];
    const rows = Array.from(element.querySelectorAll("tbody tr"), (row) => Array.from(row.querySelectorAll("td"), (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()));
    return { headers, rows };
  });
  if (table === null) throw new Error(`No hunts table on ${page.url()}`);
  // Rows without a hunt code are kept: since 16 Oct 2026 hunts are confirmed with the fox's QR code
  const { hunts, warning } = parseHuntsTable(table);
  if (warning) logger.warn(`(SCRAPER) ${warning}`);

  logger.debug(`(SCRAPER) Found ${hunts.length} hunts from website.`);
  return hunts;
}
