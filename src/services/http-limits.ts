import axios, { type AxiosInstance } from "axios";
import { errorText } from "../utils/error-text";

export const MB = 1024 * 1024;

/**
 * Give every request of this axios instance a total deadline. Under Bun, axios' `timeout` only fires when the socket
 * is idle, so a server that trickles bytes would keep the request (and a noOverlap cron) waiting forever.
 * A caller's own `signal` wins.
 */
export function withTotalDeadline(instance: AxiosInstance, ms: number): AxiosInstance {
  instance.interceptors.request.use((config) => {
    config.signal ??= AbortSignal.timeout(ms);
    return config;
  });
  return instance;
}

/** Reject when the promise has not settled within `ms` (for clients that cannot be aborted). */
export function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Drop the query string: it can carry ids or keys. */
function withoutQuery(url: string | undefined): string {
  if (!url) return "?";
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/** True when the request was aborted by its total deadline (see withTotalDeadline). */
export function isDeadlineError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const reason = (error.config?.signal as AbortSignal | undefined)?.reason as { name?: string } | undefined;
  return error.code === "ERR_CANCELED" && reason?.name === "TimeoutError";
}

/**
 * One short line for the log: `"METHOD url → status"` (the server answered) or `"METHOD url → code"` (network
 * failure, timeout). Never the headers (API keys, tokens), the request/response body or the whole error object.
 */
export function describeHttpError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const method = error.config?.method?.toUpperCase() ?? "?";
    const url = withoutQuery(error.config?.url);
    const outcome = error.response?.status ?? (isDeadlineError(error) ? "timeout" : error.code) ?? "unknown error";
    return `${method} ${url} → ${outcome}`;
  }
  return errorText(error);
}
