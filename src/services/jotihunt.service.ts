import axios from "axios";
import { logger } from "../logger";
import puppeteer, {Page} from "puppeteer";
import {ApiArea, ApiArticle, ApiTeam, WebHunt} from "../types/api";

const apiUrl = process.env.JOTIHUNT_API_URL as string;
const websiteUrl = process.env.JOTIHUNT_WEB_URL as string;
const websiteUsername = process.env.JOTIHUNT_WEB_USERNAME as string;
const websitePassword = process.env.JOTIHUNT_WEB_PASSWORD as string;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const apiClient = axios.create({
    baseURL: apiUrl,
    // Crons run with noOverlap, so a hanging request would stop them for good
    timeout: 10_000,
});

/**
 * Function to get all areas from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of areas.
 */
export async function getAreas(): Promise<ApiArea[]> {
    try {
        const response = await apiClient.get("/areas");
        return response.data.data as ApiArea[];
    } catch (error) {
        logger.error("Error fetching areas:", error);
        throw new Error("Could not fetch areas", { cause: error });
    }
}

/**
 * Function to get all articles from Jotihunt.
 * Only returns the first 15 articles.
 * @returns {Promise<Array>} - A promise that resolves to an array of articles.
 */
export async function getArticles(): Promise<ApiArticle[]> {
    try {
        const response = await apiClient.get("/articles");
        return response.data.data as ApiArticle[];
    } catch (error) {
        logger.error("Error fetching articles:", error);
        throw new Error("Could not fetch articles", { cause: error });
    }
}

/**
 * Function to get all subscribed teams (groups) from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of teams.
 */
export async function getTeams(): Promise<ApiTeam[]> {
    try {
        const response = await apiClient.get("/subscriptions");
        return response.data.data as ApiTeam[];
    } catch (error) {
        logger.error("Error fetching teams:", error);
        throw new Error("Could not fetch teams", { cause: error });
    }
}

/**
 * Use Puppeteer to login to the Jotihunt website.
 * @returns {Promise<Page>} - A promise that resolves to a Puppeteer page.
 */
export async function login(): Promise<Page> {
    // Prefer an explicit PUPPETEER_EXECUTABLE_PATH (set in the Docker image to the system chromium),
    // fall back to the system chromium in production and to puppeteer's bundled browser otherwise.
    const isProduction = process.env.NODE_ENV === "production";
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isProduction ? "/usr/bin/chromium" : undefined);
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        ...(executablePath && { executablePath }),
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent({ userAgent });

        logger.info("(SCRAPER) Logging in to Jotihunt website with e-mail: " + websiteUsername);
        await page.goto(websiteUrl + "/login", { waitUntil: "networkidle2" });
        await page.type('input[name="email"]', websiteUsername);
        await page.type('input[name="password"]', websitePassword);

        await Promise.all([page.click("button.btn"), page.waitForNavigation({ waitUntil: "networkidle2" })]);

        if (page.url().endsWith("/login")) {
            logger.error("(SCRAPER) Login failed, check your credentials.");
            await browser.close().catch(() => undefined);
            return Promise.reject(new Error("Login failed"));
        }

        logger.info("(SCRAPER) Logged in to Jotihunt website.");

        return page;
    } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
    }
}

/**
 * Scrape the last 15 hunts from the Jotihunt website.
 * @param page Logged in Puppeteer page.
 */
export async function scrapeHunts(page: Page): Promise<WebHunt[]> {
    logger.info("(SCRAPER) Scraping hunts from Jotihunt website...");

    await page.goto(websiteUrl + "/hunts");

    const hunts = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        return rows.flatMap((row) => {
            const columns = Array.from(row.querySelectorAll("td"));
            // Skip placeholder rows such as a single colspan "no hunts yet" cell
            if (columns.length < 5) return [];
            return [{
                area: columns[0].textContent,
                huntCode: columns[1].textContent,
                status: columns[2].textContent,
                points: parseInt(columns[3].textContent || "0"),
                huntTime: columns[4].textContent,
            } as WebHunt];
        });
    });

    logger.info(`(SCRAPER) Found ${hunts.length} hunts from website.`);

    return hunts;
}
