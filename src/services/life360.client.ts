import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Life360Circle } from "./life360.helpers";

/**
 * Thin client for Life360's unofficial mobile API. The headers are those of the proven test login (2026-10-13,
 * /tmp/l360-test/login.ts): the iOS client token with CloudEvents headers for the e-mail code, the Android user agent with
 * a Bearer token for data. Requests go through node:https with default TLS (Bun fetch's TLS fingerprint risks Cloudflare
 * blocks). Error messages never contain the token.
 */

export const LIFE360_BASE_URL = "https://api-cloudfront.life360.com";
/** Client token of the iOS app (accepted by /v5/users/signin/otp/*) */
const IOS_CLIENT_TOKEN = "YnJ1czR0ZXZhcHV0UmVadWNydUJSVXdVYnJFTUVDN1VYZTJlUEhhYjpSdUt1cHJBQ3JhbWVzV1UydVRyZVF1bXVtYTdhemFtQQ==";
const IOS_VERSION = "25.41.0.1674";
const ANDROID_USER_AGENT = "com.life360.android.safetymapd/KOKO/23.50.0 android/13";
/** Members of a circle are a few kB; avatars a few hundred kB */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// --- Transport ------------------------------------------------------------------------------------------------------

export interface Life360HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface Life360HttpResponse {
  status: number;
  /** Lower-case names; repeated headers joined with ", " */
  headers: Record<string, string>;
  body: Buffer;
}

export type Life360Transport = (request: Life360HttpRequest) => Promise<Life360HttpResponse>;

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

/** node:https (node:http for http: URLs, tests only), default TLS, a timeout and a body size cap. */
export function nodeTransport(timeoutMs = 15_000): Life360Transport {
  return (request) =>
    new Promise<Life360HttpResponse>((resolve, reject) => {
      const url = new URL(request.url);
      const headers = request.body === undefined ? request.headers : { ...request.headers, "content-length": String(Buffer.byteLength(request.body)) };
      const options = { method: request.method, headers };
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      // A timer for the whole request (not the socket idle timeout): a Cloudflare tarpit can trickle bytes forever
      const timer = setTimeout(() => {
        fail(new Error(`Life360 request timed out after ${timeoutMs} ms`));
        req.destroy();
      }, timeoutMs);
      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            fail(new Error("Life360 answer too large"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks) });
        });
        res.on("error", fail);
      };
      let req: http.ClientRequest;
      try {
        req = url.protocol === "http:" ? http.request(url, options, onResponse) : https.request(url, options, onResponse);
      } catch (error) {
        // e.g. a header value with a newline: node refuses to build the request
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      req.on("error", fail);
      req.end(request.body);
    });
}

// --- Errors ---------------------------------------------------------------------------------------------------------

export class Life360Error extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** 401: the token is no longer valid (no refresh exists; an admin logs in again) */
export class Life360UnauthorizedError extends Life360Error {
  constructor() {
    super("Life360 rejected the token", 401);
  }
}

/** 429 (or error code "retry-after"): wait retryAfterMs (null: Life360 didn't say) */
export class Life360RateLimitedError extends Life360Error {
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null, status = 429) {
    super(`Life360 rate limit (${status})`, status);
    this.retryAfterMs = retryAfterMs;
  }
}

/** 403: usually a Cloudflare block (HTML page) */
export class Life360BlockedError extends Life360Error {
  constructor(message = "Life360 blocked the request (403)") {
    super(message, 403);
  }
}

export class Life360NotFoundError extends Life360Error {
  constructor(message = "Not found at Life360") {
    super(message, 404);
  }
}

/** 400/409 on the code: mismatch, code-expired, exhausted, … */
export class Life360CodeInvalidError extends Life360Error {
  readonly code: string | null;
  constructor(code: string | null, status = 400) {
    super(`Life360 refused the code${code ? ` (${code})` : ""}`, status);
    this.code = code;
  }
}

/** Any other answer, or an answer without the expected fields */
export class Life360UpstreamError extends Life360Error {
  constructor(message: string, status: number | null = null) {
    super(message, status);
  }
}

/** No answer at all (DNS, connection, timeout) */
export class Life360NetworkError extends Life360Error {
  constructor(message: string) {
    super(message, null);
  }
}

// --- Helpers --------------------------------------------------------------------------------------------------------

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Retry-After as seconds or an HTTP date, in ms from `now`; null when missing or unreadable. */
export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const isHtml = (response: Life360HttpResponse) =>
  (response.headers["content-type"] ?? "").includes("text/html") || response.body.subarray(0, 64).toString("utf8").trimStart().startsWith("<");

type Step = "send" | "verify" | "data";

function failure(response: Life360HttpResponse, step: Step): Life360Error {
  const { status } = response;
  const code = nonEmpty(at(parseJson(response.body), "error", "code"));
  if (status === 429 || code === "retry-after") return new Life360RateLimitedError(parseRetryAfterMs(response.headers["retry-after"]), status);
  if (status === 401) return new Life360UnauthorizedError();
  if (status === 403) return new Life360BlockedError(isHtml(response) ? "Life360 blocked the request (403, Cloudflare page)" : "Life360 answered 403");
  if (status === 404) return new Life360NotFoundError();
  if (step === "verify" && (status === 400 || status === 409)) return new Life360CodeInvalidError(code, status);
  return new Life360UpstreamError(`Life360 answered ${status}${code ? ` (${code})` : ""}`, status);
}

function loginHeaders(deviceId: string, ceType: string): Record<string, string> {
  return {
    accept: "application/json",
    "accept-language": "en-US",
    "content-type": "application/json",
    authorization: `Basic ${IOS_CLIENT_TOKEN}`,
    "x-device-id": deviceId,
    "x-request-id": randomUUID().toUpperCase(),
    "user-agent": `SafetyMapKoko/${IOS_VERSION}/${deviceId}`,
    "ce-specversion": "1.0",
    "ce-id": randomUUID().toUpperCase(),
    "ce-time": new Date().toISOString(),
    "ce-type": ceType,
    "ce-source": `/iOS/${IOS_VERSION}/iPhone16,1/${deviceId}`,
  };
}

function dataHeaders(token: string): Record<string, string> {
  return { accept: "application/json", "cache-control": "no-cache", authorization: `Bearer ${token}`, "user-agent": ANDROID_USER_AGENT };
}

// --- Client ---------------------------------------------------------------------------------------------------------

export type Life360MembersResult = { notModified: true } | { notModified: false; etag: string | null; members: unknown[] };

/** What the service needs from Life360 (faked in tests: src/test/life360-client.ts). */
export interface Life360Api {
  sendCode(email: string, deviceId: string): Promise<{ transactionId: string }>;
  /** The access token (secret) */
  verifyCode(transactionId: string, code: string, deviceId: string): Promise<string>;
  me(token: string): Promise<{ email: string | null }>;
  /** Heavily rate-limited at Life360: only while linking, never in the poll loop */
  circles(token: string): Promise<Life360Circle[]>;
  members(token: string, circleId: string, etag?: string): Promise<Life360MembersResult>;
  requestLocation(token: string, circleId: string, memberId: string): Promise<void>;
  avatar(url: string, token: string): Promise<{ contentType: string; body: Buffer }>;
}

export class Life360Client implements Life360Api {
  private readonly transport: Life360Transport;
  private readonly baseUrl: string;

  constructor(transport: Life360Transport = nodeTransport(), baseUrl = LIFE360_BASE_URL) {
    this.transport = transport;
    this.baseUrl = baseUrl;
  }

  async sendCode(email: string, deviceId: string): Promise<{ transactionId: string }> {
    const response = await this.call(
      { method: "POST", url: `${this.baseUrl}/v5/users/signin/otp/send`, headers: loginHeaders(deviceId, "com.life360.device.signin-otp.v2"), body: JSON.stringify({ email }) },
      "send",
    );
    const transactionId = nonEmpty(at(parseJson(response.body), "data", "transactionId"));
    if (!transactionId) throw new Life360UpstreamError("Life360 sent no transactionId", response.status);
    return { transactionId };
  }

  async verifyCode(transactionId: string, code: string, deviceId: string): Promise<string> {
    const response = await this.call(
      {
        method: "POST",
        url: `${this.baseUrl}/v5/users/signin/otp/token`,
        headers: loginHeaders(deviceId, "com.life360.device.signin-token-otp.v1"),
        body: JSON.stringify({ transactionId, code }),
      },
      "verify",
    );
    const json = parseJson(response.body);
    const token = nonEmpty(at(json, "access_token")) ?? nonEmpty(at(json, "data", "access_token"));
    if (!token) throw new Life360UpstreamError("Life360 sent no access_token", response.status);
    return token;
  }

  async me(token: string): Promise<{ email: string | null }> {
    const response = await this.call({ method: "GET", url: `${this.baseUrl}/v3/users/me`, headers: dataHeaders(token) }, "data");
    return { email: nonEmpty(at(parseJson(response.body), "loginEmail")) };
  }

  async circles(token: string): Promise<Life360Circle[]> {
    const response = await this.call({ method: "GET", url: `${this.baseUrl}/v4/circles`, headers: dataHeaders(token) }, "data");
    const list = at(parseJson(response.body), "circles");
    if (!Array.isArray(list)) throw new Life360UpstreamError("Unexpected circles answer", response.status);
    return list.flatMap((circle) => {
      const id = nonEmpty(at(circle, "id"));
      return id ? [{ id, name: nonEmpty(at(circle, "name")) ?? id }] : [];
    });
  }

  async members(token: string, circleId: string, etag?: string): Promise<Life360MembersResult> {
    const headers = dataHeaders(token);
    if (etag) headers["if-none-match"] = etag;
    const response = await this.call({ method: "GET", url: `${this.baseUrl}/v3/circles/${encodeURIComponent(circleId)}/members`, headers }, "data");
    if (response.status === 304) return { notModified: true };
    const list = at(parseJson(response.body), "members");
    if (!Array.isArray(list)) throw new Life360UpstreamError("Unexpected members answer", response.status);
    return { notModified: false, etag: nonEmpty(response.headers["l360-etag"]), members: list };
  }

  async requestLocation(token: string, circleId: string, memberId: string): Promise<void> {
    await this.call(
      {
        method: "POST",
        url: `${this.baseUrl}/v3/circles/${encodeURIComponent(circleId)}/members/${encodeURIComponent(memberId)}/request`,
        headers: { ...dataHeaders(token), "content-type": "application/x-www-form-urlencoded" },
        body: "type=location",
      },
      "data",
    );
  }

  /** Only https URLs on life360.com (the avatar URLs Life360 itself sends), so the token never goes elsewhere. */
  async avatar(url: string, token: string): Promise<{ contentType: string; body: Buffer }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Life360NotFoundError("Invalid avatar URL");
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || (host !== "life360.com" && !host.endsWith(".life360.com"))) throw new Life360NotFoundError("Avatar not on life360.com");
    const response = await this.call({ method: "GET", url: parsed.toString(), headers: { ...dataHeaders(token), accept: "image/*" } }, "data");
    const contentType = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (response.status !== 200 || !contentType.startsWith("image/")) throw new Life360UpstreamError(`Avatar is not an image (${contentType || "no type"})`, response.status);
    return { contentType, body: response.body };
  }

  private async call(request: Life360HttpRequest, step: Step): Promise<Life360HttpResponse> {
    let response: Life360HttpResponse;
    try {
      response = await this.transport(request);
    } catch (error) {
      throw new Life360NetworkError(`Life360 not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((response.status >= 200 && response.status < 300) || response.status === 304) return response;
    throw failure(response, step);
  }
}
