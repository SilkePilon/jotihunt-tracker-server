import { describe, expect, test } from "bun:test";
import { JotiboardAuthError, JotiboardClient, JotiboardLoginError, JotiboardUpstreamError } from "./jotiboard.client";
import { JOTIBOARD_API_KEY, JOTIBOARD_DB_URL, jotiboardConfigFromEnv, jotiboardEmail } from "./jotiboard.helpers";

const NOW = 1_792_000_000_000;
type Call = { url: string; init?: RequestInit };

function fakeFetch(answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("helpers", () => {
  test("e-mail from the username", () => {
    expect(jotiboardEmail("  User ")).toBe("user@jotiboard.local");
  });
  test("config from env", () => {
    const warnings: string[] = [];
    expect(jotiboardConfigFromEnv({}, (m) => warnings.push(m))).toBeNull();
    expect(jotiboardConfigFromEnv({ JOTIBOARD_SESSION_KEY: "short" }, (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(jotiboardConfigFromEnv({ JOTIBOARD_SESSION_KEY: key }, () => {})).toEqual({ sessionKey: key });
  });
});

describe("signIn", () => {
  test("posts the e-mail and password, returns the session", async () => {
    const { impl, calls } = fakeFetch([json(200, { localId: "uid-1", idToken: "id-1", refreshToken: "rt-1", expiresIn: "3600" })]);
    const session = await new JotiboardClient(impl, () => NOW).signIn("user", "secret-pw");
    expect(session).toEqual({ idToken: "id-1", refreshToken: "rt-1", uid: "uid-1", expiresAt: new Date(NOW + 3600_000) });
    expect(calls[0].url).toBe(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${JOTIBOARD_API_KEY}`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ email: "user@jotiboard.local", password: "secret-pw", returnSecureToken: true });
  });

  test.each([
    ["INVALID_LOGIN_CREDENTIALS", "invalid"],
    ["INVALID_PASSWORD", "invalid"],
    ["EMAIL_NOT_FOUND", "invalid"],
    ["TOO_MANY_ATTEMPTS_TRY_LATER : Access disabled", "tooMany"],
    ["USER_DISABLED", "disabled"],
  ])("%s → %s", async (message, code) => {
    const { impl } = fakeFetch([json(400, { error: { message } })]);
    const error = await new JotiboardClient(impl).signIn("user", "x").catch((e) => e);
    expect(error).toBeInstanceOf(JotiboardLoginError);
    expect(error.code).toBe(code);
  });

  test("network failure and other answers are upstream errors", async () => {
    const { impl } = fakeFetch([new TypeError("fetch failed"), json(500, {})]);
    const client = new JotiboardClient(impl);
    expect(await client.signIn("u", "p").catch((e) => e)).toBeInstanceOf(JotiboardUpstreamError);
    expect(await client.signIn("u", "p").catch((e) => e)).toBeInstanceOf(JotiboardUpstreamError);
  });

  test("the password never ends up in an error message", async () => {
    const { impl } = fakeFetch([json(500, { error: { message: "boom" } })]);
    const error = await new JotiboardClient(impl).signIn("u", "secret-pw").catch((e) => e);
    expect(String(error.message)).not.toContain("secret-pw");
  });
});

describe("refresh", () => {
  test("form-encoded refresh, returns the new session", async () => {
    const { impl, calls } = fakeFetch([json(200, { id_token: "id-2", refresh_token: "rt-2", user_id: "uid-1", expires_in: "3600" })]);
    const session = await new JotiboardClient(impl, () => NOW).refresh("rt-1");
    expect(session).toEqual({ idToken: "id-2", refreshToken: "rt-2", uid: "uid-1", expiresAt: new Date(NOW + 3600_000) });
    expect(calls[0].url).toBe(`https://securetoken.googleapis.com/v1/token?key=${JOTIBOARD_API_KEY}`);
    expect(String(calls[0].init?.body)).toBe("grant_type=refresh_token&refresh_token=rt-1");
  });
  test("400 means the session is gone", async () => {
    const { impl } = fakeFetch([json(400, { error: { message: "TOKEN_EXPIRED" } })]);
    expect(await new JotiboardClient(impl).refresh("rt").catch((e) => e)).toBeInstanceOf(JotiboardAuthError);
  });
});

describe("read", () => {
  test("GETs <DB>/<path>.json?auth=", async () => {
    const { impl, calls } = fakeFetch([json(200, { a: 1 }), json(200, null)]);
    const client = new JotiboardClient(impl);
    expect(await client.read("manualLocations", "id-1")).toEqual({ a: 1 });
    expect(await client.read("hintSolves", "id-1")).toBeNull();
    expect(calls[0].url).toBe(`${JOTIBOARD_DB_URL}/manualLocations.json?auth=id-1`);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });
  test("401 is an auth error, 500 upstream", async () => {
    const { impl } = fakeFetch([json(401, { error: "Permission denied" }), json(500, {})]);
    const client = new JotiboardClient(impl);
    expect(await client.read("x", "t").catch((e) => e)).toBeInstanceOf(JotiboardAuthError);
    expect(await client.read("x", "t").catch((e) => e)).toBeInstanceOf(JotiboardUpstreamError);
  });
});
