import { describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  Life360BlockedError,
  Life360Client,
  Life360CodeInvalidError,
  Life360NetworkError,
  Life360NotFoundError,
  Life360RateLimitedError,
  Life360UnauthorizedError,
  Life360UpstreamError,
  nodeTransport,
  parseRetryAfterMs,
  type Life360HttpRequest,
  type Life360Transport,
} from "./life360.client";

const DEVICE = "0F8E2C3A-1111-2222-3333-444455556666";
const ANDROID_UA = "com.life360.android.safetymapd/KOKO/23.50.0 android/13";

type Answer = { status?: number; headers?: Record<string, string>; json?: unknown; body?: string | Buffer } | Error;

/** A transport that records the requests and answers from the queue (no network). */
function fakeTransport(...answers: Answer[]) {
  const requests: Life360HttpRequest[] = [];
  const transport: Life360Transport = async (request) => {
    requests.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("No answer queued");
    if (answer instanceof Error) throw answer;
    const body =
      answer.json !== undefined ? Buffer.from(JSON.stringify(answer.json)) : typeof answer.body === "string" ? Buffer.from(answer.body) : (answer.body ?? Buffer.alloc(0));
    return { status: answer.status ?? 200, headers: answer.headers ?? {}, body };
  };
  return { client: new Life360Client(transport), requests };
}

const failure = (promise: Promise<unknown>) => promise.then(
  () => {
    throw new Error("Expected a rejection");
  },
  (error: unknown) => error,
);

describe("login (e-mail code)", () => {
  test("sendCode: iOS client token, CloudEvents headers and the device id, like the proven test login", async () => {
    const { client, requests } = fakeTransport({ json: { data: { transactionId: "tx-1", email: "a@b.nl", verificationType: "email" } } });
    expect(await client.sendCode("a@b.nl", DEVICE)).toEqual({ transactionId: "tx-1" });
    const [request] = requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api-cloudfront.life360.com/v5/users/signin/otp/send");
    expect(JSON.parse(request.body!)).toEqual({ email: "a@b.nl" });
    expect(request.headers).toMatchObject({
      authorization: "Basic YnJ1czR0ZXZhcHV0UmVadWNydUJSVXdVYnJFTUVDN1VYZTJlUEhhYjpSdUt1cHJBQ3JhbWVzV1UydVRyZVF1bXVtYTdhemFtQQ==",
      "content-type": "application/json",
      accept: "application/json",
      "accept-language": "en-US",
      "x-device-id": DEVICE,
      "user-agent": `SafetyMapKoko/25.41.0.1674/${DEVICE}`,
      "ce-specversion": "1.0",
      "ce-type": "com.life360.device.signin-otp.v2",
      "ce-source": `/iOS/25.41.0.1674/iPhone16,1/${DEVICE}`,
    });
    expect(request.headers["ce-id"]).toMatch(/^[0-9A-F-]{36}$/);
    expect(request.headers["x-request-id"]).toMatch(/^[0-9A-F-]{36}$/);
    expect(new Date(request.headers["ce-time"]).toISOString()).toBe(request.headers["ce-time"]);
  });

  test("sendCode errors: 404 no account, 429 with Retry-After, 403 Cloudflare HTML, 400 syntax, no transactionId", async () => {
    const { client } = fakeTransport(
      { status: 404, json: { errorMessage: "Not Found" } },
      { status: 429, headers: { "retry-after": "120" }, body: "error code: 1015" },
      { status: 403, headers: { "content-type": "text/html; charset=UTF-8" }, body: "<!DOCTYPE html><title>Sorry, you have been blocked</title>" },
      { status: 400, json: { error: { message: "Input parameter(s) not valid", code: "syntax" } } },
      { json: { data: {} } },
    );
    expect(await failure(client.sendCode("x@y.nl", DEVICE))).toBeInstanceOf(Life360NotFoundError);
    const limited = await failure(client.sendCode("x@y.nl", DEVICE));
    expect(limited).toBeInstanceOf(Life360RateLimitedError);
    expect((limited as Life360RateLimitedError).retryAfterMs).toBe(120_000);
    expect(await failure(client.sendCode("x@y.nl", DEVICE))).toBeInstanceOf(Life360BlockedError);
    const syntax = await failure(client.sendCode("x@y.nl", DEVICE));
    expect(syntax).toBeInstanceOf(Life360UpstreamError);
    expect(syntax).toMatchObject({ status: 400 });
    expect(await failure(client.sendCode("x@y.nl", DEVICE))).toBeInstanceOf(Life360UpstreamError);
  });

  test("a 'retry-after' error code counts as rate limited, whatever the status", async () => {
    const { client } = fakeTransport({ status: 400, json: { error: { code: "retry-after" } } });
    expect(await failure(client.sendCode("x@y.nl", DEVICE))).toBeInstanceOf(Life360RateLimitedError);
  });

  test("verifyCode: token request with transactionId and code; the access_token comes back", async () => {
    const { client, requests } = fakeTransport({ json: { access_token: "tok-123", token_type: "Bearer", multi_device: false } });
    expect(await client.verifyCode("tx-1", "123456", DEVICE)).toBe("tok-123");
    expect(requests[0].url).toBe("https://api-cloudfront.life360.com/v5/users/signin/otp/token");
    expect(JSON.parse(requests[0].body!)).toEqual({ transactionId: "tx-1", code: "123456" });
    expect(requests[0].headers["ce-type"]).toBe("com.life360.device.signin-token-otp.v1");
  });

  test("verifyCode errors: 409 code-expired and 400 mismatch are CodeInvalid; 200 without token is Upstream", async () => {
    const { client } = fakeTransport(
      { status: 409, json: { error: { message: "code expired", code: "code-expired" } } },
      { status: 400, json: { error: { code: "mismatch" } } },
      { json: { token_type: "Bearer" } },
    );
    const expired = await failure(client.verifyCode("tx", "000000", DEVICE));
    expect(expired).toBeInstanceOf(Life360CodeInvalidError);
    expect(expired).toMatchObject({ code: "code-expired", status: 409 });
    expect(await failure(client.verifyCode("tx", "000000", DEVICE))).toMatchObject({ code: "mismatch", status: 400 });
    expect(await failure(client.verifyCode("tx", "000000", DEVICE))).toBeInstanceOf(Life360UpstreamError);
  });
});

describe("data", () => {
  test("me: Android user agent and Bearer token; the account e-mail; 401 is Unauthorized", async () => {
    const { client, requests } = fakeTransport({ json: { id: "u1", loginEmail: "jotihunt@example.nl" } }, { status: 401, json: { errorMessage: "Invalid token" } });
    expect(await client.me("tok")).toEqual({ email: "jotihunt@example.nl" });
    expect(requests[0]).toMatchObject({ method: "GET", url: "https://api-cloudfront.life360.com/v3/users/me" });
    expect(requests[0].headers).toEqual({ accept: "application/json", "cache-control": "no-cache", authorization: "Bearer tok", "user-agent": ANDROID_UA });
    expect(await failure(client.me("tok"))).toBeInstanceOf(Life360UnauthorizedError);
  });

  test("circles: id and name; entries without id are skipped", async () => {
    const { client, requests } = fakeTransport({ json: { circles: [{ id: "c1", name: "Jotihunt", color: "x" }, { id: "c2" }, { name: "geen id" }] } });
    expect(await client.circles("tok")).toEqual([
      { id: "c1", name: "Jotihunt" },
      { id: "c2", name: "c2" },
    ]);
    expect(requests[0].url).toBe("https://api-cloudfront.life360.com/v4/circles");
  });

  test("members: etag out, if-none-match back, 304 not modified", async () => {
    const { client, requests } = fakeTransport({ headers: { "l360-etag": "v1" }, json: { members: [{ id: "m1" }] } }, { status: 304 }, { json: { nope: true } });
    expect(await client.members("tok", "c1")).toEqual({ notModified: false, etag: "v1", members: [{ id: "m1" }] });
    expect(requests[0].url).toBe("https://api-cloudfront.life360.com/v3/circles/c1/members");
    expect(requests[0].headers["if-none-match"]).toBeUndefined();
    expect(await client.members("tok", "c1", "v1")).toEqual({ notModified: true });
    expect(requests[1].headers["if-none-match"]).toBe("v1");
    expect(await failure(client.members("tok", "c1"))).toBeInstanceOf(Life360UpstreamError);
  });

  test("requestLocation: form body type=location", async () => {
    const { client, requests } = fakeTransport({ json: { requestId: "r1" } }, { status: 404, json: {} });
    await client.requestLocation("tok", "c1", "m1");
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://api-cloudfront.life360.com/v3/circles/c1/members/m1/request", body: "type=location" });
    expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(await failure(client.requestLocation("tok", "c1", "m2"))).toBeInstanceOf(Life360NotFoundError);
  });

  test("a transport failure is a NetworkError without the token in its message", async () => {
    const { client } = fakeTransport(new Error("socket hang up"));
    const error = await failure(client.members("secret-token", "c1"));
    expect(error).toBeInstanceOf(Life360NetworkError);
    expect(String((error as Error).message)).not.toContain("secret-token");
  });
});

describe("avatar", () => {
  test("only https URLs on life360.com are fetched; the image comes back with its type", async () => {
    const { client, requests } = fakeTransport({ headers: { "content-type": "image/jpeg" }, body: Buffer.from([0xff, 0xd8, 0xff]) }, { headers: { "content-type": "text/html" }, body: "<html>" });
    expect(await failure(client.avatar("https://evil.example/x.jpg", "tok"))).toBeInstanceOf(Life360NotFoundError);
    expect(await failure(client.avatar("http://www.life360.com/x.jpg", "tok"))).toBeInstanceOf(Life360NotFoundError);
    expect(await failure(client.avatar("not a url", "tok"))).toBeInstanceOf(Life360NotFoundError);
    expect(requests).toHaveLength(0);
    const image = await client.avatar("https://www.life360.com/img/user_images/m1.jpg", "tok");
    expect(image.contentType).toBe("image/jpeg");
    expect([...image.body]).toEqual([0xff, 0xd8, 0xff]);
    expect(requests[0].headers.accept).toBe("image/*");
    expect(await failure(client.avatar("https://www.life360.com/img/user_images/m2.jpg", "tok"))).toBeInstanceOf(Life360UpstreamError);
  });
});

describe("parseRetryAfterMs", () => {
  test("seconds or an HTTP date; nothing usable → null", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(parseRetryAfterMs("61726", now)).toBe(61_726_000);
    expect(parseRetryAfterMs("Thu, 15 Oct 2026 12:10:00 GMT", now)).toBe(600_000);
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs("-3", now)).toBeNull();
  });
});

describe("nodeTransport (local node:http server, no internet)", () => {
  async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test("sends method, headers and body; returns status, lower-case headers and the bytes", async () => {
    await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.setHeader("L360-ETag", "v1");
          res.setHeader("Set-Cookie", ["a=1", "b=2"]);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ method: req.method, url: req.url, length: req.headers["content-length"], ua: req.headers["user-agent"], body }));
        });
      },
      async (base) => {
        const response = await nodeTransport()({ method: "POST", url: `${base}/v3/x?y=1`, headers: { "user-agent": "test" }, body: "type=location" });
        expect(response.status).toBe(201);
        expect(response.headers["l360-etag"]).toBe("v1");
        expect(response.headers["set-cookie"]).toBe("a=1, b=2");
        expect(JSON.parse(response.body.toString("utf8"))).toEqual({ method: "POST", url: "/v3/x?y=1", length: "13", ua: "test", body: "type=location" });
      },
    );
  });

  test("a server that doesn't answer in time rejects", async () => {
    await withServer(
      () => undefined,
      async (base) => {
        await expect(nodeTransport(50)({ method: "GET", url: `${base}/slow`, headers: {} })).rejects.toThrow(/timed out/);
      },
    );
  });

  test("a request node refuses to build (bad header value) rejects without a stray timer afterwards", async () => {
    await expect(nodeTransport(20)({ method: "GET", url: "http://127.0.0.1:1/x", headers: { authorization: "Bearer a\nb" } })).rejects.toThrow();
    // Past the timeout: the timer must not fire into an unbuilt request
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});
