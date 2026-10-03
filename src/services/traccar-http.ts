import axios from "axios";
import { describeHttpError, MB, withTotalDeadline } from "./http-limits";

// Shared axios client for the Traccar REST API. Kept free of the logger import so services can use it.
// TRACCARR_* is the old, misspelled name; still read so existing .env files keep working
export const usesLegacyTraccarEnv = !process.env.TRACCAR_API_URL && !process.env.TRACCAR_API_TOKEN && Boolean(process.env.TRACCARR_API_URL || process.env.TRACCARR_API_TOKEN);
const apiUrl = process.env.TRACCAR_API_URL ?? process.env.TRACCARR_API_URL;
const apiToken = process.env.TRACCAR_API_TOKEN ?? process.env.TRACCARR_API_TOKEN;

export const isTraccarConfigured = Boolean(apiUrl && apiToken);

/** Total time per Traccar request (axios' own timeout is idle-only under Bun) */
export const TRACCAR_DEADLINE_MS = 10_000;

export const traccarHttp = withTotalDeadline(
  axios.create({
    baseURL: apiUrl,
    timeout: TRACCAR_DEADLINE_MS,
    maxContentLength: 5 * MB,
    maxBodyLength: 5 * MB,
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  }),
  TRACCAR_DEADLINE_MS,
);

/**
 * Summarise a Traccar request failure for logging, without the Authorization header or any
 * request/response body: `"METHOD url → status"` (Traccar responded) or `"METHOD url → code"`
 * (network/timeout failure, e.g. ECONNREFUSED).
 */
export function describeTraccarError(error: unknown): string {
  return describeHttpError(error);
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
