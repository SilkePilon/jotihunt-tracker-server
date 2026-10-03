import axios from "axios";
import { logger } from "../logger";
import { ApiArea, ApiArticle, ApiTeam } from "../types/api";
import { describeHttpError, MB, withTotalDeadline } from "./http-limits";

const apiUrl = process.env.JOTIHUNT_API_URL as string;

/** Total time per request: crons run with noOverlap, so a hanging request would stop them for good */
export const JOTIHUNT_DEADLINE_MS = 10_000;

const apiClient = withTotalDeadline(
  axios.create({
    baseURL: apiUrl,
    timeout: JOTIHUNT_DEADLINE_MS,
    maxContentLength: 5 * MB,
    maxBodyLength: 5 * MB,
  }),
  JOTIHUNT_DEADLINE_MS,
);

/** A failed call to the Jotihunt API; the message is one short line (never the axios error itself). */
export class JotihuntApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JotihuntApiError";
  }
}

/** Calls are skipped while the API asked us to back off (429) or kept failing. */
export class JotihuntPausedError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Jotihunt API paused for ${Math.ceil(remainingMs / 1000)} s after errors`);
    this.name = "JotihuntPausedError";
  }
}

/**
 * Backoff for the Jotihunt API (docs: 30 calls/min, then 429, and when you keep going a full block).
 * A 429 pauses every call at once; other errors (5xx, network, timeouts) only after a few in a row.
 * The pause doubles per failure from 1 to 5 minutes (a longer Retry-After wins, up to 15 minutes); a success resets it.
 */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const RETRY_AFTER_MAX_MS = 15 * 60_000;
/** Consecutive non-429 failures before calls are paused */
export const ERRORS_BEFORE_PAUSE = 3;

let clock: () => number = () => Date.now();
let failures = 0;
let pauses = 0;
let pausedUntil = 0;

/** Tests only */
export function setJotihuntApiUrl(url: string) {
  apiClient.defaults.baseURL = url;
}

/** Tests only */
export function resetJotihuntBackoff(now?: () => number) {
  clock = now ?? (() => Date.now());
  failures = 0;
  pauses = 0;
  pausedUntil = 0;
}

/** Milliseconds left of the current pause (0 when calls are allowed). */
export function jotihuntPausedFor(): number {
  return Math.max(0, pausedUntil - clock());
}

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function recordSuccess() {
  failures = 0;
  pauses = 0;
}

function recordFailure(error: unknown) {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  failures++;
  if (status !== 429 && failures < ERRORS_BEFORE_PAUSE) return;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** pauses, BACKOFF_MAX_MS);
  const retryAfter = status === 429 && axios.isAxiosError(error) ? parseRetryAfter(error.response?.headers?.["retry-after"], clock()) : undefined;
  const pause = Math.max(backoff, Math.min(retryAfter ?? 0, RETRY_AFTER_MAX_MS));
  pauses++;
  pausedUntil = clock() + pause;
  logger.warn(`Jotihunt API ${status === 429 ? "rate limit (429)" : `failed ${failures} times in a row`}: pausing calls for ${Math.round(pause / 1000)} s`);
}

/**
 * GET a Jotihunt API path, honouring the backoff. Every answer is `{"data": [...]}`; anything else (e.g. a Cloudflare
 * HTML page with status 200) counts as a failure. Throws JotihuntPausedError / JotihuntApiError.
 */
async function apiGet(path: string, what: string, params?: Record<string, unknown>): Promise<{ data: unknown[] }> {
  const remaining = jotihuntPausedFor();
  if (remaining > 0) throw new JotihuntPausedError(remaining);
  let description: string;
  let status: number | undefined;
  try {
    const response = await apiClient.get(path, { params });
    if (Array.isArray((response.data as { data?: unknown } | null)?.data)) {
      recordSuccess();
      return response.data as { data: unknown[] };
    }
    recordFailure(undefined);
    description = `GET ${path} → unexpected response`;
  } catch (error) {
    recordFailure(error);
    description = describeHttpError(error);
    status = axios.isAxiosError(error) ? error.response?.status : undefined;
  }
  logger.error(`Error fetching ${what}: ${description}`);
  throw new JotihuntApiError(`Could not fetch ${what} (${description})`, status);
}

/** The `data` list of an API answer without null or non-object entries. */
function dataList<T>(body: { data: unknown[] }): T[] {
  return body.data.filter((item): item is T => typeof item === "object" && item !== null);
}

/**
 * Function to get all areas from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of areas.
 */
export async function getAreas(): Promise<ApiArea[]> {
  return dataList<ApiArea>(await apiGet("/areas", "areas"));
}

export interface ArticlesPage {
  articles: ApiArticle[];
  /** The page number of the last page (1 when the API does not say) */
  lastPage: number;
  /** Articles per page (15 when the API does not say) */
  perPage: number;
}

/** One page (15 articles, newest first) of the Jotihunt articles. */
export async function getArticlesPage(page = 1): Promise<ArticlesPage> {
  const body = await apiGet("/articles", "articles", page > 1 ? { page } : undefined);
  const meta = (body as { meta?: { last_page?: unknown; per_page?: unknown } } | null)?.meta;
  return {
    articles: dataList<ApiArticle>(body),
    lastPage: typeof meta?.last_page === "number" ? meta.last_page : 1,
    perPage: typeof meta?.per_page === "number" ? meta.per_page : 15,
  };
}

/**
 * Function to get all articles from Jotihunt.
 * Only returns the first 15 articles.
 * @returns {Promise<Array>} - A promise that resolves to an array of articles.
 */
export async function getArticles(): Promise<ApiArticle[]> {
  return (await getArticlesPage(1)).articles;
}

/**
 * Function to get all subscribed teams (groups) from Jotihunt.
 * @returns {Promise<Array>} - A promise that resolves to an array of teams.
 */
export async function getTeams(): Promise<ApiTeam[]> {
  return dataList<ApiTeam>(await apiGet("/subscriptions", "teams"));
}
