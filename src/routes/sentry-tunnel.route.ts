import express, { Router } from "express";
import { logger } from "../logger";

/** Response headers of Sentry the browser SDK reads to back off when the quota is hit. */
const RELAYED_HEADERS = ["x-sentry-rate-limits", "retry-after"];

/** Host and project id of a Sentry DSN (https://<key>@<host>/<projectId>), or null when it is not one. */
export function parseDsn(dsn: string): { host: string; projectId: string } | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.host || !/^\d+$/.test(projectId)) return null;
    return { host: url.host, projectId };
  } catch {
    return null;
  }
}

/**
 * Forward a website Sentry envelope to sentry.io. Only envelopes for the website's own project are forwarded, so
 * the route can not be used to send anything anywhere else.
 */
export async function forwardEnvelope(
  body: Buffer,
  siteDsn: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body?: string; headers?: Record<string, string> }> {
  const site = siteDsn?.trim() ? parseDsn(siteDsn.trim()) : null;
  if (!site) return { status: 404 };

  const headerLine = body.subarray(0, Math.max(0, body.indexOf(0x0a))).toString("utf8");
  let target: { host: string; projectId: string } | null = null;
  try {
    const header = JSON.parse(headerLine) as { dsn?: unknown } | null;
    if (typeof header?.dsn === "string") target = parseDsn(header.dsn);
  } catch {
    // Not an envelope
  }
  if (!target || target.host !== site.host || target.projectId !== site.projectId) return { status: 400 };

  try {
    const response = await fetchImpl(`https://${site.host}/api/${site.projectId}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: new Uint8Array(body),
    });
    const headers: Record<string, string> = {};
    for (const name of RELAYED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: response.status, body: await response.text(), headers };
  } catch (error) {
    logger.warn(`Sentry tunnel: could not reach Sentry: ${error}`);
    return { status: 502 };
  }
}

const router = Router();

// Ad blockers on hunters' phones block sentry.io; the website sends its error reports here (same origin) instead.
// Replay chunks are the largest envelopes (compressed, well below 1 MB).
router.post("/", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const result = await forwardEnvelope(body, process.env.SENTRY_SITE_DSN);
  res.status(result.status).set(result.headers ?? {}).send(result.body ?? "");
});

export default router;
