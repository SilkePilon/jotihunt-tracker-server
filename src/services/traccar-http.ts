import axios from "axios";

// Shared axios client for the Traccar REST API. Kept free of the logger import so services can use it.
const apiUrl = process.env.TRACCARR_API_URL;
const apiToken = process.env.TRACCARR_API_TOKEN;

export const isTraccarConfigured = Boolean(apiUrl && apiToken);

export const traccarHttp = axios.create({
  baseURL: apiUrl,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${apiToken}`,
  },
});

/** Drop the query string: Traccar requests can carry ids, but never put secrets there either way. */
function withoutQuery(url: string | undefined): string {
  if (!url) return "?";
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Summarise a Traccar request failure for logging, without the Authorization header or any
 * request/response body: `"METHOD url → status"` (Traccar responded) or `"METHOD url → code"`
 * (network/timeout failure, e.g. ECONNREFUSED).
 */
export function describeTraccarError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const method = error.config?.method?.toUpperCase() ?? "?";
    const url = withoutQuery(error.config?.url);
    const outcome = error.response?.status ?? error.code ?? "unknown error";
    return `${method} ${url} → ${outcome}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when Traccar rejected a device create/update with a 400 that names the group (e.g. an
 * unknown or foreign-key-violating groupId), as opposed to being unreachable or erroring for some
 * other reason. Only inspects the response body to classify the error; never logs it.
 */
export function isGroupInvalidError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return false;
  const body = error.response?.data;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /group|foreign key/i.test(text);
}
