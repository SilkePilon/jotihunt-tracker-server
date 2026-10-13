import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { life360LinkModel } from "../models/life360-link.model";
import { FakeLife360Client, TOKEN } from "../test/life360-client";
import { DEVICE_FIX_ISO, FIX_ISO, FIX_TIME, rawDeviceLocation, rawMember } from "../test/life360-fixtures";
import { Life360BlockedError, Life360CodeInvalidError, Life360NetworkError, Life360NotFoundError, Life360RateLimitedError, Life360UnauthorizedError, Life360UpstreamError } from "./life360.client";
import type { Life360Config } from "./life360.helpers";
import { Life360Service, type Life360ServiceOptions } from "./life360.service";
import { decryptSession } from "./telegram.helpers";

const KEY = randomBytes(32).toString("base64");
const EMAIL = "jotihunt@example.nl";
const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";

/** Stands in for the demo state store's connection to the real database */
let realDb: Connection;
let client: FakeLife360Client;
let clock: Date;
let service: Life360Service;
const logs: string[] = [];
const logger = { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };

function createService(config: Life360Config | null = { sessionKey: KEY }, extra: Partial<Life360ServiceOptions> = {}) {
  return new Life360Service({ config, connection: realDb, client, logger, autoPoll: false, now: () => clock, ...extra });
}
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
const M1_AVATAR = "https://www.life360.com/img/user_images/m1.jpg";
const M2_AVATAR = "https://www.life360.com/img/user_images/m2.jpg";
const JPEG_IMAGE = { contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) };
const membersAnswer = (...members: unknown[]) => ({ notModified: false as const, etag: "etag-1", members });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out");
};
/** Code + verify with the only circle: linked */
async function link() {
  await service.sendCode(EMAIL);
  return service.verifyCode("123456", "Admin");
}

beforeAll(async () => {
  realDb = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await life360LinkModel(realDb).deleteMany({});
  client = new FakeLife360Client();
  clock = new Date((FIX_TIME + 60) * 1000);
  logs.length = 0;
  service = createService();
  await service.start();
});
afterEach(() => service.stop());
afterAll(async () => {
  await realDb.close();
});

describe("feature off", () => {
  test("without LIFE360_SESSION_KEY: unavailable, logins refused, members empty", async () => {
    const off = createService(null);
    await off.start();
    expect(off.available).toBe(false);
    expect(off.status()).toEqual({ state: "unavailable" });
    await expect(off.sendCode(EMAIL)).rejects.toMatchObject({ status: 503 });
    await expect(off.pasteToken("tok", "Admin")).rejects.toMatchObject({ status: 503 });
    await expect(off.unlink()).rejects.toMatchObject({ status: 503 });
    expect(off.members()).toEqual({ linked: false, stale: false, members: [] });
    await off.stop();
  });
});

describe("linking", () => {
  test("e-mail code → linked with the only circle; the token is stored encrypted and never shown or logged", async () => {
    expect(service.status()).toEqual({ state: "unlinked" });
    expect(await service.sendCode(EMAIL)).toEqual({ state: "code", email: EMAIL, resendAt: new Date(clock.getTime() + 60_000).toISOString() });
    expect(client.calls[0]).toMatch(/^send jotihunt@example\.nl [0-9A-F-]{36}$/);

    const linked = await service.verifyCode("123456", "Admin");
    expect(linked).toEqual({ state: "linked", email: EMAIL, circleName: "Jotihunt", memberCount: 0, liveCount: 0, lastPollAt: null, refreshAvailableAt: null });
    expect(client.calls).toContain("verify tx-1 123456");

    const doc = await life360LinkModel(realDb).findOne().lean();
    expect(doc).toMatchObject({ key: "life360", email: EMAIL, circleId: "c1", circleName: "Jotihunt", linkedBy: "Admin" });
    expect(doc!.deviceId).toBe(client.calls[0].split(" ")[2]);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    expect(decryptSession({ ciphertext: doc!.tokenCiphertext, iv: doc!.iv, tag: doc!.tag }, KEY)).toBe(TOKEN);
    expect(service.nextPollAt).toEqual(clock);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  test("a new code only after 60 s", async () => {
    await service.sendCode(EMAIL);
    await expect(service.sendCode(EMAIL)).rejects.toMatchObject({ status: 429 });
    advance(60_000);
    expect((await service.sendCode(EMAIL)).state).toBe("code");
    expect(client.calls.filter((call) => call.startsWith("send"))).toHaveLength(2);
  });

  test("send errors: no account 404, bad address 400, unreachable 502, Life360 limit 429 for at least 2 minutes", async () => {
    client.sendError = new Life360NotFoundError();
    await expect(service.sendCode("x@example.nl")).rejects.toMatchObject({ status: 404, message: "Geen Life360-account met dit adres." });
    expect(service.status()).toEqual({ state: "unlinked" });
    client.sendError = new Life360UpstreamError("Life360 answered 400 (syntax)", 400);
    await expect(service.sendCode("x@example.nl")).rejects.toMatchObject({ status: 400, message: "E-mailadres is ongeldig." });
    client.sendError = new Life360NetworkError("ECONNRESET");
    await expect(service.sendCode("x@example.nl")).rejects.toMatchObject({ status: 502 });
    client.sendError = new Life360RateLimitedError(null);
    await expect(service.sendCode("x@example.nl")).rejects.toMatchObject({ status: 429 });
    client.sendError = null;
    advance(119_000);
    await expect(service.sendCode("x@example.nl")).rejects.toMatchObject({ status: 429 });
    advance(1_000);
    expect((await service.sendCode("x@example.nl")).state).toBe("code");
  });

  test("verify: 409 without a pending code; 400 on a wrong code and the code stays pending", async () => {
    await expect(service.verifyCode("123456", "Admin")).rejects.toMatchObject({ status: 409 });
    await service.sendCode(EMAIL);
    client.verifyError = new Life360CodeInvalidError("mismatch");
    await expect(service.verifyCode("000000", "Admin")).rejects.toMatchObject({ status: 400, message: "Code klopt niet of is verlopen." });
    expect(service.status().state).toBe("code");
    client.verifyError = new Life360RateLimitedError(30_000);
    await expect(service.verifyCode("000000", "Admin")).rejects.toMatchObject({ status: 429 });
  });

  test("more than one circle: the admin picks one", async () => {
    client.circleList = [
      { id: "c1", name: "Jotihunt" },
      { id: "c2", name: "Familie" },
    ];
    await expect(service.chooseCircle("c1", "Admin")).rejects.toMatchObject({ status: 409 });
    await service.sendCode(EMAIL);
    expect(await service.verifyCode("123456", "Admin")).toEqual({ state: "circle", email: EMAIL, circles: client.circleList });
    expect(await life360LinkModel(realDb).countDocuments()).toBe(0);
    await expect(service.chooseCircle("c9", "Admin")).rejects.toMatchObject({ status: 400, message: "Onbekende kring." });
    expect(await service.chooseCircle("c2", "Admin")).toMatchObject({ state: "linked", circleName: "Familie" });
    expect((await life360LinkModel(realDb).findOne().lean())!.circleId).toBe("c2");
  });

  test("paste token: checked with /users/me, e-mail from the account, 'Bearer ' prefix removed", async () => {
    client.meError = new Life360UnauthorizedError();
    await expect(service.pasteToken("bad", "Admin")).rejects.toMatchObject({ status: 400, message: "Token werkt niet." });
    client.meError = null;
    client.circleList = [];
    await expect(service.pasteToken("tok", "Admin")).rejects.toMatchObject({ status: 400, message: "Dit Life360-account zit in geen enkele kring." });
    client.circleList = [{ id: "c1", name: "Jotihunt" }];
    client.circlesError = new Life360RateLimitedError(null);
    await expect(service.pasteToken("tok", "Admin")).rejects.toMatchObject({ status: 429 });
    client.circlesError = null;
    expect(await service.pasteToken("Bearer  tok ", "Admin")).toMatchObject({ state: "linked", email: EMAIL, circleName: "Jotihunt" });
    expect(client.calls).toContain("me tok");
  });
});

describe("pending code expiry", () => {
  test("a pending login expires 10 minutes after the code was sent", async () => {
    await service.sendCode(EMAIL);
    advance(10 * 60_000 - 1);
    expect(service.status().state).toBe("code");
    advance(1);
    expect(service.status()).toEqual({ state: "unlinked" });
    await expect(service.verifyCode("123456", "Admin")).rejects.toMatchObject({ status: 409 });
    expect(client.calls.some((call) => call.startsWith("verify"))).toBe(false);
  });

  test("an expired re-login of a linked account falls back to the existing link", async () => {
    await link();
    advance(60_000);
    await service.sendCode("ander@example.nl");
    advance(10 * 60_000);
    expect(service.status()).toMatchObject({ state: "linked", email: EMAIL });
  });
});

describe("polling", () => {
  test("first poll: the roster (v3) and the positions (v5); then v5 every 30 s and the roster every 5 minutes (full call)", async () => {
    await link();
    client.memberAnswers = [
      membersAnswer(
        rawMember("m1", "Silke", "Pilon"),
        rawMember("m2", "Anna", "", { shareLocation: "0" }),
        rawMember("m3", "Bram", "de Vries", { location: { timestamp: String(FIX_TIME - 20 * 60) } }),
      ),
      { notModified: true },
    ];
    await service.pollOnce();
    expect(client.memberRequests).toEqual([{ token: TOKEN, circleId: "c1", etag: undefined }]);
    expect(client.deviceRequests).toEqual([{ token: TOKEN, circleId: "c1" }]);
    expect(service.members().members.map((member) => [member.id, member.name, member.location !== null])).toEqual([
      ["m1", "Silke P.", true],
      ["m2", "Anna", false],
      ["m3", "Bram D.", true],
    ]);
    expect(service.status()).toEqual({ state: "linked", email: EMAIL, circleName: "Jotihunt", memberCount: 3, liveCount: 1, lastPollAt: clock.toISOString(), refreshAvailableAt: null });
    expect(service.nextPollAt).toEqual(new Date(clock.getTime() + 30_000));

    for (let i = 0; i < 9; i++) {
      advance(30_000);
      await service.pollOnce();
    }
    expect(client.memberRequests).toHaveLength(1);
    expect(client.deviceRequests).toHaveLength(10);
    expect(service.members().members).toHaveLength(3);
    expect(service.nextPollAt).toEqual(new Date(clock.getTime() + 30_000));

    advance(30_000);
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(2);
    expect(client.memberRequests[1].etag).toBeUndefined();
    expect(client.deviceRequests).toHaveLength(11);
  });

  test("location null while still sharing: the last known location stays; not sharing or gone from the circle: dropped", async () => {
    await link();
    client.memberAnswers = [
      membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", "B"), rawMember("m3", "Bram", "C")),
      { notModified: false, etag: "etag-2", members: [rawMember("m1", "Silke", "Pilon", { location: null }), rawMember("m2", "Anna", "B", { location: null, shareLocation: "0" })] },
      { notModified: false, etag: "etag-3", members: [rawMember("m1", "Silke", "Pilon", { location: null }), rawMember("m3", "Bram", "C", { location: null })] },
    ];
    await service.pollOnce();
    const first = service.members().members[0].location;
    expect(first).not.toBeNull();

    advance(5 * 60_000);
    await service.pollOnce();
    expect(service.members().members.map((member) => [member.id, member.location])).toEqual([
      ["m1", first],
      ["m2", null],
    ]);

    // m1 keeps the carried-over fix again; m3 came back without a fix after being gone: nothing to carry over
    advance(5 * 60_000);
    await service.pollOnce();
    expect(service.members().members.map((member) => [member.id, member.location])).toEqual([
      ["m1", first],
      ["m3", null],
    ]);
  });

  test("401: logged out, polling stops, the last members stay (stale); logging in again resumes", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon")), new Life360UnauthorizedError()];
    await service.pollOnce();
    advance(5 * 60_000);
    await service.pollOnce();
    expect(service.status()).toEqual({ state: "loggedOut", email: EMAIL, circleName: "Jotihunt" });
    expect(service.members()).toMatchObject({ linked: true, stale: true });
    expect(service.members().members).toHaveLength(1);
    expect(service.nextPollAt).toBeNull();
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(2);

    advance(60_000);
    await service.sendCode(EMAIL);
    expect((await service.verifyCode("123456", "Admin")).state).toBe("linked");
    expect(service.members()).toMatchObject({ linked: true, stale: false });
    expect(service.members().members).toHaveLength(1);
  });

  test("429: paused until Retry-After, at least 5 minutes; then linked again", async () => {
    await link();
    client.memberAnswers = [new Life360RateLimitedError(60_000), new Life360RateLimitedError(2 * 60 * 60_000), membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    const retryAt = new Date(clock.getTime() + 5 * 60_000);
    expect(service.status()).toEqual({ state: "paused", email: EMAIL, circleName: "Jotihunt", retryAt: retryAt.toISOString(), memberCount: 0, liveCount: 0 });
    expect(service.nextPollAt).toEqual(retryAt);
    expect(service.members()).toEqual({ linked: true, stale: true, members: [] });

    clock = retryAt;
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "paused", retryAt: new Date(clock.getTime() + 2 * 60 * 60_000).toISOString() });

    advance(2 * 60 * 60_000);
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "linked", memberCount: 1 });
    expect(service.nextPollAt).toEqual(new Date(clock.getTime() + 30_000));
  });

  test("403 (Cloudflare block): paused 5 minutes", async () => {
    await link();
    client.memberAnswers = [new Life360BlockedError()];
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "paused", retryAt: new Date(clock.getTime() + 5 * 60_000).toISOString() });
  });

  test("network and unexpected errors: retried with backoff up to 5 minutes, the state stays linked", async () => {
    await link();
    client.memberAnswers = [new Life360NetworkError("ECONNRESET"), new Life360UpstreamError("Life360 answered 502", 502), new Life360NetworkError("ETIMEDOUT")];
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await service.pollOnce();
      const wait = service.nextPollAt!.getTime() - clock.getTime();
      waits.push(wait);
      advance(wait);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(service.status().state).toBe("linked");
    client.memberAnswers = [membersAnswer()];
    await service.pollOnce();
    expect(service.nextPollAt!.getTime() - clock.getTime()).toBe(30_000);
  });

  test("the poll loop runs on its own", async () => {
    await service.stop();
    service = createService({ sessionKey: KEY }, { autoPoll: true, pollIntervalMs: 5 });
    await service.start();
    await link();
    await until(() => client.deviceRequests.length >= 3);
  });
});

describe("v5 positions", () => {
  const at = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
  const locations = () => service.members().members.map((member) => [member.id, member.location && [member.location.lat, member.location.at]]);

  test("the v5 position wins over v3; members only from the roster; liveCount uses the merged fix time", async () => {
    await link();
    client.memberAnswers = [
      membersAnswer(
        rawMember("m1", "Silke", "Pilon"),
        rawMember("m2", "Anna", "B", { location: null }),
        rawMember("m3", "Bram", "C", { location: { timestamp: String(FIX_TIME - 20 * 60) } }),
        rawMember("m4", "Dirk", "D", { location: null }),
      ),
    ];
    client.deviceAnswers = [[rawDeviceLocation("m1"), rawDeviceLocation("m2", { latitude: 52.2 }), rawDeviceLocation("m3", { latitude: 52.3 }), rawDeviceLocation("stranger")]];
    await service.pollOnce();
    expect(locations()).toEqual([
      ["m1", [52.1, DEVICE_FIX_ISO]],
      ["m2", [52.2, DEVICE_FIX_ISO]],
      ["m3", [52.3, DEVICE_FIX_ISO]],
      ["m4", null],
    ]);
    expect(service.status()).toMatchObject({ state: "linked", memberCount: 4, liveCount: 3 });
  });

  test("between roster calls only v5 moves members; a device missing from v5 keeps its last position, not the older v3 one", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", "B"))];
    client.deviceAnswers = [[rawDeviceLocation("m1"), rawDeviceLocation("m2")], [rawDeviceLocation("m1", { latitude: 52.5, lastObserved: at(DEVICE_FIX_ISO, 30) })]];
    await service.pollOnce();
    advance(30_000);
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(1);
    expect(locations()).toEqual([
      ["m1", [52.5, at(DEVICE_FIX_ISO, 30)]],
      ["m2", [52.1, DEVICE_FIX_ISO]],
    ]);
  });

  test("a phone fix is carried over: an older v5 item at the next poll does not replace it", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [[rawDeviceLocation("m1", { latitude: 52.5, lastObserved: at(DEVICE_FIX_ISO, 30) })], [rawDeviceLocation("m1", { latitude: 51.9, lastObserved: at(DEVICE_FIX_ISO, -600) })]];
    await service.pollOnce();
    advance(30_000);
    await service.pollOnce();
    expect(locations()).toEqual([["m1", [52.5, at(DEVICE_FIX_ISO, 30)]]]);
  });

  test("sharing turned off (seen at the next roster call): no position, even when v5 still has one", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon")), membersAnswer(rawMember("m1", "Silke", "Pilon", { shareLocation: "0" }))];
    client.deviceAnswers = [[rawDeviceLocation("m1")]];
    await service.pollOnce();
    advance(5 * 60_000);
    await service.pollOnce();
    expect(locations()).toEqual([["m1", null]]);
  });

  test("v5 401: logged out, no more calls", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [new Life360UnauthorizedError()];
    await service.pollOnce();
    expect(service.status()).toEqual({ state: "loggedOut", email: EMAIL, circleName: "Jotihunt" });
    expect(service.members()).toMatchObject({ stale: true });
    expect(service.members().members).toHaveLength(1);
    expect(service.nextPollAt).toBeNull();
  });

  test("v5 429 and 403: paused like v3 (the roster of that poll is kept); then both calls again", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [new Life360RateLimitedError(10 * 60_000), new Life360BlockedError(), [rawDeviceLocation("m1")]];
    await service.pollOnce();
    const retryAt = new Date(clock.getTime() + 10 * 60_000);
    expect(service.status()).toEqual({ state: "paused", email: EMAIL, circleName: "Jotihunt", retryAt: retryAt.toISOString(), memberCount: 1, liveCount: 1 });
    expect(service.nextPollAt).toEqual(retryAt);

    clock = retryAt;
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "paused", retryAt: new Date(clock.getTime() + 5 * 60_000).toISOString() });

    advance(5 * 60_000);
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "linked" });
    expect(client.memberRequests).toHaveLength(3);
    expect(locations()).toEqual([["m1", [52.1, DEVICE_FIX_ISO]]]);
  });

  test("v5 network and unexpected errors: backoff up to 5 minutes, still linked", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [new Life360NetworkError("ECONNRESET"), new Life360UpstreamError("Life360 answered 502", 502), new Life360NetworkError("ETIMEDOUT")];
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await service.pollOnce();
      const wait = service.nextPollAt!.getTime() - clock.getTime();
      waits.push(wait);
      advance(wait);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000]);
    expect(service.status().state).toBe("linked");
    expect(service.members().members[0].location!.at).toBe(FIX_ISO);
  });

  test("v5 404 or 400 (endpoint gone): logged once, v3 positions every 30 s instead of pausing; v5 tried again after an hour", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [new Life360NotFoundError()];
    await service.pollOnce();
    expect(service.status()).toMatchObject({ state: "linked", memberCount: 1, liveCount: 1 });
    expect(service.nextPollAt).toEqual(new Date(clock.getTime() + 30_000));
    expect(client.memberRequests).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      advance(30_000);
      await service.pollOnce();
    }
    expect(client.deviceRequests).toHaveLength(1);
    expect(client.memberRequests).toHaveLength(4);
    expect(client.memberRequests[1].etag).toBe("etag-1");
    expect(logs.filter((line) => line.includes("v5"))).toHaveLength(1);

    client.deviceAnswers = [new Life360UpstreamError("Life360 answered 400", 400)];
    advance(60 * 60_000);
    await service.pollOnce();
    expect(client.deviceRequests).toHaveLength(2);
    expect(service.status().state).toBe("linked");
    advance(30_000);
    await service.pollOnce();
    expect(client.deviceRequests).toHaveLength(2);
    expect(logs.filter((line) => line.includes("v5"))).toHaveLength(2);

    client.deviceAnswers = [[rawDeviceLocation("m1")]];
    advance(60 * 60_000);
    await service.pollOnce();
    advance(30_000);
    const rosterCalls = client.memberRequests.length;
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(rosterCalls);
    expect(client.deviceRequests).toHaveLength(4);
    expect(locations()).toEqual([["m1", [52.1, DEVICE_FIX_ISO]]]);
  });

  test("v5 gone on a poll without a roster call: the roster (v3 positions) is fetched in the same poll", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    client.deviceAnswers = [[], new Life360NotFoundError()];
    await service.pollOnce();
    advance(30_000);
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(2);
    expect(service.status().state).toBe("linked");
    expect(locations()).toEqual([["m1", [52.0907, FIX_ISO]]]);
  });

  test("a v5 call that was running during unlink is dropped", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    advance(30_000);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const original = client.deviceLocations.bind(client);
    client.deviceLocations = async (token, circleId) => {
      await hold;
      return original(token, circleId);
    };
    client.deviceAnswers = [[rawDeviceLocation("m1")]];
    const poll = service.pollOnce();
    await service.unlink();
    release();
    await poll;
    expect(service.members()).toEqual({ linked: false, stale: false, members: [] });
    expect(service.nextPollAt).toBeNull();
  });
});

describe("restart and unlink", () => {
  test("restart: the stored link is loaded and polled again", async () => {
    await link();
    await service.stop();
    service = createService();
    await service.start();
    expect(service.status()).toMatchObject({ state: "linked", email: EMAIL, circleName: "Jotihunt", lastPollAt: null });
    expect(service.nextPollAt).toEqual(clock);
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    expect(client.memberRequests.at(-1)).toMatchObject({ token: TOKEN, circleId: "c1" });
    expect(service.members().members).toHaveLength(1);
  });

  test("restart with another LIFE360_SESSION_KEY: logged out (an admin logs in again), the link is kept", async () => {
    await link();
    await service.stop();
    service = createService({ sessionKey: randomBytes(32).toString("base64") });
    await service.start();
    expect(service.status()).toEqual({ state: "loggedOut", email: EMAIL, circleName: "Jotihunt" });
    expect(service.nextPollAt).toBeNull();
    expect(logs.some((line) => line.includes("decrypt"))).toBe(true);
    expect(await life360LinkModel(realDb).countDocuments()).toBe(1);
  });

  test("unlink deletes the link and clears the members; with a pending login it only cancels that login", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    advance(60_000);
    await service.sendCode("ander@example.nl");
    expect(service.status().state).toBe("code");

    expect(await service.unlink()).toMatchObject({ state: "linked", circleName: "Jotihunt" });
    expect(await life360LinkModel(realDb).countDocuments()).toBe(1);

    expect(await service.unlink()).toEqual({ state: "unlinked" });
    expect(await life360LinkModel(realDb).countDocuments()).toBe(0);
    expect(service.members()).toEqual({ linked: false, stale: false, members: [] });
    expect(service.nextPollAt).toBeNull();
  });

  test("unlink while a login step is running: 409 busy, so the database and memory never disagree", async () => {
    await service.sendCode(EMAIL);
    let release!: () => void;
    client.meHold = new Promise<void>((resolve) => (release = resolve));
    const verify = service.verifyCode("123456", "Admin");
    await until(() => client.calls.some((call) => call.startsWith("me ")));
    await expect(service.unlink()).rejects.toMatchObject({ status: 409 });
    release();
    expect((await verify).state).toBe("linked");
    expect(await life360LinkModel(realDb).countDocuments()).toBe(1);
    expect(await service.unlink()).toEqual({ state: "unlinked" });
    expect(await life360LinkModel(realDb).countDocuments()).toBe(0);
  });

  test("cancelling a re-login after its code expired only clears that login; the link stays and keeps polling", async () => {
    await link();
    advance(60_000);
    await service.sendCode("ander@example.nl");
    advance(10 * 60_000 + 1);
    // An admin page reading the status after the expiry must not turn the cancel into a delete
    expect(service.status()).toMatchObject({ state: "linked", email: EMAIL });
    expect(await service.unlink()).toMatchObject({ state: "linked", email: EMAIL, circleName: "Jotihunt" });
    expect(await life360LinkModel(realDb).countDocuments()).toBe(1);
    expect(service.status()).toMatchObject({ state: "linked", email: EMAIL });
    await expect(service.verifyCode("123456", "Admin")).rejects.toMatchObject({ status: 409 });
    expect(service.nextPollAt).not.toBeNull();
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(1);
  });

  test("unlink whose database delete fails: still linked and still polling", async () => {
    await link();
    const links = (service as unknown as { links: { deleteOne: () => Promise<unknown> } }).links;
    const original = links.deleteOne;
    links.deleteOne = async () => {
      throw new Error("database down");
    };
    try {
      await expect(service.unlink()).rejects.toThrow("database down");
    } finally {
      links.deleteOne = original;
    }
    expect(service.status().state).toBe("linked");
    expect(service.nextPollAt).not.toBeNull();
    await service.pollOnce();
    expect(client.memberRequests).toHaveLength(1);
  });

  test("a poll that was running during unlink is dropped", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    let release!: () => void;
    client.hold = new Promise<void>((resolve) => (release = resolve));
    const poll = service.pollOnce();
    await service.unlink();
    release();
    await poll;
    expect(service.members()).toEqual({ linked: false, stale: false, members: [] });
    expect(service.nextPollAt).toBeNull();
  });
});

describe("refresh and avatars", () => {
  test("refresh asks every member for a fresh fix (404s ignored), at most once per minute", async () => {
    await expect(service.refresh()).rejects.toMatchObject({ status: 409 });
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", ""))];
    await service.pollOnce();
    client.requestErrors.set("m1", new Life360NotFoundError());
    const available = new Date(clock.getTime() + 60_000).toISOString();
    expect(await service.refresh()).toEqual({ refreshAvailableAt: available });
    await until(() => client.requested.length === 2);
    expect(client.requested).toEqual(["m1", "m2"]);
    expect(service.status()).toMatchObject({ refreshAvailableAt: available });
    await expect(service.refresh()).rejects.toMatchObject({ status: 429 });
    advance(60_000);
    expect(service.status()).toMatchObject({ refreshAvailableAt: null });
    await service.refresh();
  });

  test("avatars are proxied with a 1 hour cache; members without an avatar or unknown ids: 404", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", "", { avatar: null }))];
    await service.pollOnce();
    const jpeg = { contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) };
    client.avatars.set("https://www.life360.com/img/user_images/m1.jpg", jpeg);
    expect(await service.avatar("m1")).toEqual(jpeg);
    await service.avatar("m1");
    expect(client.avatarCalls).toBe(1);
    advance(60 * 60_000);
    await service.avatar("m1");
    expect(client.avatarCalls).toBe(2);
    await expect(service.avatar("m2")).rejects.toMatchObject({ status: 404 });
    await expect(service.avatar("nobody")).rejects.toMatchObject({ status: 404 });
  });

  test("logged out: avatars only from the cache (also when older than 1 h), Life360 is not called with the dead token", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", ""))];
    await service.pollOnce();
    client.deviceAnswers = [new Life360UnauthorizedError()];
    const jpeg = { contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) };
    client.avatars.set("https://www.life360.com/img/user_images/m1.jpg", jpeg);
    client.avatars.set("https://www.life360.com/img/user_images/m2.jpg", jpeg);
    await service.avatar("m1");
    advance(30_000);
    await service.pollOnce();
    expect(service.status().state).toBe("loggedOut");

    advance(2 * 60 * 60_000);
    expect(await service.avatar("m1")).toEqual(jpeg);
    await expect(service.avatar("m2")).rejects.toMatchObject({ status: 404 });
    expect(client.avatarCalls).toBe(1);
  });

  test("paused: avatars only from the cache (whatever its age), Life360 is not called", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", ""))];
    await service.pollOnce();
    client.deviceAnswers = [new Life360RateLimitedError(null)];
    client.avatars.set(M1_AVATAR, JPEG_IMAGE);
    client.avatars.set(M2_AVATAR, JPEG_IMAGE);
    await service.avatar("m1");
    advance(30_000);
    await service.pollOnce();
    expect(service.status().state).toBe("paused");

    advance(2 * 60 * 60_000);
    expect(await service.avatar("m1")).toEqual(JPEG_IMAGE);
    await expect(service.avatar("m2")).rejects.toMatchObject({ status: 404 });
    expect(client.avatarCalls).toBe(1);
  });

  test("a failed avatar is remembered for 5 minutes (404 or 502 without asking Life360 again)", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"), rawMember("m2", "Anna", ""))];
    await service.pollOnce();
    client.avatarErrors.set(M1_AVATAR, new Life360UpstreamError("Avatar is not an image (text/html)", 301));
    await expect(service.avatar("m1")).rejects.toMatchObject({ status: 502 });
    await expect(service.avatar("m2")).rejects.toMatchObject({ status: 404 });
    expect(client.avatarCalls).toBe(2);
    client.avatarErrors.clear();
    client.avatars.set(M1_AVATAR, JPEG_IMAGE);
    client.avatars.set(M2_AVATAR, JPEG_IMAGE);
    advance(4 * 60_000);
    await expect(service.avatar("m1")).rejects.toMatchObject({ status: 502 });
    await expect(service.avatar("m2")).rejects.toMatchObject({ status: 404 });
    expect(client.avatarCalls).toBe(2);
    advance(60_000);
    expect(await service.avatar("m1")).toEqual(JPEG_IMAGE);
    expect(await service.avatar("m2")).toEqual(JPEG_IMAGE);
    expect(client.avatarCalls).toBe(4);
  });

  test("concurrent requests for one avatar share one Life360 call", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    client.avatars.set(M1_AVATAR, JPEG_IMAGE);
    let release!: () => void;
    client.avatarHold = new Promise<void>((resolve) => (release = resolve));
    const all = Promise.all([service.avatar("m1"), service.avatar("m1"), service.avatar("m1")]);
    await until(() => client.avatarCalls > 0);
    release();
    expect(await all).toEqual([JPEG_IMAGE, JPEG_IMAGE, JPEG_IMAGE]);
    expect(client.avatarCalls).toBe(1);
    // A failure is shared too
    client.avatarHold = null;
    advance(60 * 60_000);
    client.avatarErrors.set(M1_AVATAR, new Life360UpstreamError("boom"));
    client.avatars.delete(M1_AVATAR);
    const stale = await Promise.all([service.avatar("m1"), service.avatar("m1")]);
    expect(stale).toEqual([JPEG_IMAGE, JPEG_IMAGE]);
    expect(client.avatarCalls).toBe(2);
  });

  test("an avatar fetch from before an unlink and relink does not drop the newer shared fetch", async () => {
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    client.avatars.set(M1_AVATAR, JPEG_IMAGE);
    let releaseOld!: () => void;
    client.avatarHold = new Promise<void>((resolve) => (releaseOld = resolve));
    const old = service.avatar("m1");
    await until(() => client.avatarCalls === 1);
    await service.unlink();
    advance(60_000);
    await link();
    client.memberAnswers = [membersAnswer(rawMember("m1", "Silke", "Pilon"))];
    await service.pollOnce();
    let releaseNew!: () => void;
    client.avatarHold = new Promise<void>((resolve) => (releaseNew = resolve));
    const first = service.avatar("m1");
    await until(() => client.avatarCalls === 2);
    releaseOld();
    await old;
    const second = service.avatar("m1");
    releaseNew();
    expect(await Promise.all([first, second])).toEqual([JPEG_IMAGE, JPEG_IMAGE]);
    expect(client.avatarCalls).toBe(2);
  });
});
