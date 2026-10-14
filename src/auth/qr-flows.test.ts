import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installFakeWebauthn } from "../test/webauthn";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { tokenFor, withSession } from "../test/auth";
import { User } from "../models/user.model";
import { sessions } from "./models";
import { createAccount } from "./user-store";
import { signDeviceToken } from "../services/access-token";

installFakeWebauthn();
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
process.env.PUBLIC_APP_URL = "https://jotihunt.test";
const { app } = await import("../app");

let server: Server;
let base: string;
beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(clearTestDb);
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

const LAPTOP_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
function request(path: string, init: RequestInit & { token?: string; json?: unknown; secret?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.secret !== undefined) headers.set("X-Qr-Secret", init.secret);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  headers.set("User-Agent", LAPTOP_UA);
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const passkey = (id: string) => ({ credentialId: id, publicKey: Buffer.from(`pk-${id}`), counter: 0, transports: ["internal"], name: "Test" });
type Qr = { id: string; code: string; pollSecret: string; url: string; expiresAt: string };

async function startQr(headers: Record<string, string> = {}) {
  const res = await request("/auth/qr", { method: "POST", headers });
  expect(res.status).toBe(201);
  return json<Qr>(res);
}
const poll = (qr: Qr, secret = qr.pollSecret) => request(`/auth/qr/${qr.id}`, { secret });
const scan = (qr: Qr, token: string) => request(`/auth/qr/scan/${qr.code}`, { method: "POST", token });
const approve = (qr: Qr, token: string, id = "cred-1", signature = "valid") =>
  request(`/auth/qr/scan/${qr.code}/approve`, { method: "POST", token, json: { response: { id, response: { signature } } } });

describe("QR login", () => {
  test("laptop shows a code, phone scans and approves with its passkey, laptop gets a session once", async () => {
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const previous = process.env.CLIENT_IP_HEADER;
    process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
    let qr: Qr;
    try {
      qr = await startQr({ "cf-ipcity": "Arnhem" });
    } finally {
      if (previous === undefined) delete process.env.CLIENT_IP_HEADER;
      else process.env.CLIENT_IP_HEADER = previous;
    }
    expect(qr.url).toBe(`https://jotihunt.test/l/${qr.code}`);
    expect((await json(await poll(qr))).status).toBe("waiting");

    const scanned = await scan(qr, tokenFor(jesse));
    expect(scanned.status).toBe(200);
    const body = await json<{ requester: unknown; options: { allowCredentials: { id: string }[] } }>(scanned);
    expect(body.requester).toEqual({ label: "Firefox op Linux", location: "Arnhem" });
    expect(body.options.allowCredentials.map((entry) => entry.id)).toEqual(["cred-1"]);
    expect(await json(await poll(qr))).toMatchObject({ status: "scanned", scannedBy: { name: "Jesse" } });

    expect((await approve(qr, tokenFor(jesse))).status).toBe(204);
    const done = await poll(qr);
    expect(done.status).toBe(200);
    const result = await json<{ status: string; token: string; user: { name: string } }>(done);
    expect(result.status).toBe("approved");
    expect(result.user.name).toBe("Jesse");
    expect((await request("/auth/me", { token: result.token })).status).toBe(200);
    const laptopSession = await sessions().findOne({ via: "qr" }).lean();
    expect(laptopSession).toMatchObject({ label: "Firefox op Linux" });
    expect((await User.findById(jesse._id))!.passkeys[0].counter).toBe(1);
    expect((await poll(qr)).status).toBe(404);
  });

  test("without CLIENT_IP_HEADER=cf-connecting-ip the Cloudflare location headers are ignored", async () => {
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const previous = process.env.CLIENT_IP_HEADER;
    delete process.env.CLIENT_IP_HEADER;
    let qr: Qr;
    try {
      qr = await startQr({ "cf-ipcity": "Arnhem", "cf-ipcountry": "NL" });
    } finally {
      if (previous !== undefined) process.env.CLIENT_IP_HEADER = previous;
    }
    const body = await json<{ requester: unknown }>(await scan(qr, tokenFor(jesse)));
    expect(body.requester).toEqual({ label: "Firefox op Linux", location: null });
  });

  test("a wrong poll secret is a 404 and never hands over the session", async () => {
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const qr = await startQr();
    await scan(qr, tokenFor(jesse));
    await approve(qr, tokenFor(jesse));
    const wrong = await poll(qr, "guess");
    expect(wrong.status).toBe(404);
    expect((await json(wrong)).code).toBe("QR_GONE");
    expect((await json(await poll(qr))).status).toBe("approved");
  });

  test("a bad assertion or another user's passkey is 401 and can be retried; a second scanner gets QR_TAKEN", async () => {
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const noor = await withSession(await createAccount({ name: "Noor", passkey: passkey("cred-2") }));
    const qr = await startQr();
    await scan(qr, tokenFor(jesse));
    const taken = await scan(qr, tokenFor(noor));
    expect(taken.status).toBe(409);
    expect((await json(taken)).code).toBe("QR_TAKEN");
    const forged = await approve(qr, tokenFor(jesse), "cred-1", "forged");
    expect(forged.status).toBe(401);
    expect((await json(forged)).code).toBe("PASSKEY_FAILED");
    expect((await approve(qr, tokenFor(jesse), "cred-2")).status).toBe(401);
    expect((await approve(qr, tokenFor(noor), "cred-2")).status).toBe(404);
    expect((await approve(qr, tokenFor(jesse))).status).toBe(204);
  });

  test("deny: the laptop sees denied and approving afterwards is QR_GONE", async () => {
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const qr = await startQr();
    await scan(qr, tokenFor(jesse));
    expect((await request(`/auth/qr/scan/${qr.code}/deny`, { method: "POST", token: tokenFor(jesse) })).status).toBe(204);
    expect((await json(await poll(qr))).status).toBe("denied");
    expect((await approve(qr, tokenFor(jesse))).status).toBe(404);
  });

  test("users without a passkey get NO_PASSKEY and the code stays waiting; unknown codes are QR_GONE", async () => {
    const noPasskey = await withSession(await User.create({ name: "Tim" }));
    const qr = await startQr();
    const res = await scan(qr, tokenFor(noPasskey));
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("NO_PASSKEY");
    expect((await json(await poll(qr))).status).toBe("waiting");
    const jesse = await withSession(await createAccount({ name: "Jesse", passkey: passkey("cred-1") }));
    const unknown = await request("/auth/qr/scan/does-not-exist", { method: "POST", token: tokenFor(jesse) });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).code).toBe("QR_GONE");
  });

  test("phone endpoints need a web session: no token 401, a paired phone's device token 403", async () => {
    const jesse = await createAccount({ name: "Jesse", passkey: passkey("cred-1") });
    await User.updateOne({ _id: jesse._id }, { $push: { devices: { id: "phone-1", name: "Pixel", createdAt: new Date() } } });
    const qr = await startQr();
    expect((await request(`/auth/qr/scan/${qr.code}`, { method: "POST" })).status).toBe(401);
    expect((await scan(qr, signDeviceToken(jesse, "phone-1"))).status).toBe(403);
  });
});
