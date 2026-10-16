import { JOTIBOARD_API_KEY, JOTIBOARD_DB_URL, jotiboardEmail } from "./jotiboard.helpers";
import { errorText } from "../utils/error-text";

/** Firebase Auth + RTDB over plain REST. Error messages never contain the password or tokens. */

export interface JotiboardSession {
  idToken: string;
  refreshToken: string;
  uid: string;
  expiresAt: Date;
}

export interface JotiboardApi {
  signIn(username: string, password: string): Promise<JotiboardSession>;
  refresh(refreshToken: string): Promise<JotiboardSession>;
  /** The JSON at `path` (null when empty) */
  read(path: string, idToken: string): Promise<unknown>;
}

/** Wrong credentials, too many attempts or a disabled account (signIn only) */
export class JotiboardLoginError extends Error {
  constructor(readonly code: "invalid" | "tooMany" | "disabled") {
    super(`Jotiboard login refused (${code})`);
    this.name = "JotiboardLoginError";
  }
}

/** The stored session is no longer valid: an admin has to log in again */
export class JotiboardAuthError extends Error {
  constructor(message = "Jotiboard session no longer valid") {
    super(message);
    this.name = "JotiboardAuthError";
  }
}

/** Network failure or an unexpected answer: try again later */
export class JotiboardUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JotiboardUpstreamError";
  }
}

const TIMEOUT_MS = 15_000;

function loginCode(message: string): JotiboardLoginError["code"] | null {
  if (/^(INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL)/.test(message)) return "invalid";
  if (message.startsWith("TOO_MANY_ATTEMPTS_TRY_LATER")) return "tooMany";
  if (message.startsWith("USER_DISABLED")) return "disabled";
  return null;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string };
    if (typeof body.error === "string") return body.error;
    return typeof body.error?.message === "string" ? body.error.message : "";
  } catch {
    return "";
  }
}

export class JotiboardClient implements JotiboardApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async signIn(username: string, password: string): Promise<JotiboardSession> {
    const response = await this.send(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${JOTIBOARD_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: jotiboardEmail(username), password, returnSecureToken: true }),
    });
    if (response.status === 400) {
      const message = await errorMessage(response);
      const code = loginCode(message);
      if (code) throw new JotiboardLoginError(code);
      throw new JotiboardUpstreamError(`Jotiboard login answered 400 (${message || "no message"})`);
    }
    if (!response.ok) throw new JotiboardUpstreamError(`Jotiboard login answered ${response.status}`);
    const body = (await response.json()) as { localId: string; idToken: string; refreshToken: string; expiresIn: string };
    return { idToken: body.idToken, refreshToken: body.refreshToken, uid: body.localId, expiresAt: this.expiry(body.expiresIn) };
  }

  async refresh(refreshToken: string): Promise<JotiboardSession> {
    const response = await this.send(`https://securetoken.googleapis.com/v1/token?key=${JOTIBOARD_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new JotiboardAuthError(`Jotiboard refresh refused (${(await errorMessage(response)) || response.status})`);
    }
    if (!response.ok) throw new JotiboardUpstreamError(`Jotiboard refresh answered ${response.status}`);
    const body = (await response.json()) as { id_token: string; refresh_token: string; user_id: string; expires_in: string };
    return { idToken: body.id_token, refreshToken: body.refresh_token, uid: body.user_id, expiresAt: this.expiry(body.expires_in) };
  }

  async read(path: string, idToken: string): Promise<unknown> {
    const response = await this.send(`${JOTIBOARD_DB_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`, { method: "GET" });
    if (response.status === 401 || response.status === 403) throw new JotiboardAuthError(`Jotiboard refused reading ${path}`);
    if (!response.ok) throw new JotiboardUpstreamError(`Jotiboard read of ${path} answered ${response.status}`);
    return response.json();
  }

  private expiry(expiresIn: string): Date {
    const seconds = Number(expiresIn);
    return new Date(this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      // The URL holds the API key / ID token: only the error's own message
      throw new JotiboardUpstreamError(`Jotiboard not reachable: ${errorText(error)}`);
    }
  }
}
