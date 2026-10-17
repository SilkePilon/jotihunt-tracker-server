import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { jotiboardLinkModel } from "../models/jotiboard-link.model";
import { FakeImporter, FakeJotiboardClient, PASSWORD } from "../test/jotiboard-client";
import { JotiboardAuthError, JotiboardLoginError, JotiboardUpstreamError } from "./jotiboard.client";
import { JotiboardService, POLL_INTERVAL_MS, type JotiboardServiceOptions } from "./jotiboard.service";
import { decryptSession } from "./session-crypto";
import { setDemoModeFlag } from "../demo/demo-mode";

const KEY = randomBytes(32).toString("base64");
const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let realDb: Connection;
let clock: Date;
let client: FakeJotiboardClient;
let importer: FakeImporter;
let service: JotiboardService;
const logs: string[] = [];
const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

function createService(extra: Partial<JotiboardServiceOptions> = {}) {
  return new JotiboardService({ config: { sessionKey: KEY }, connection: realDb, client, importer, logger, autoPoll: false, now: () => clock, ...extra });
}

beforeAll(async () => {
  realDb = await mongoose.createConnection(uri).asPromise();
});
beforeEach(async () => {
  await jotiboardLinkModel(realDb).deleteMany({});
  clock = new Date("2026-10-17T12:00:00Z");
  client = new FakeJotiboardClient(() => clock);
  importer = new FakeImporter();
  logs.length = 0;
  service = createService();
  await service.start();
});
afterEach(() => service.stop());
afterAll(() => realDb.close());

describe("feature off", () => {
  test("without a key: unavailable, link refused", async () => {
    const off = createService({ config: null });
    await off.start();
    expect(await off.status()).toEqual({ state: "unavailable" });
    await expect(off.link("user", PASSWORD, "Admin")).rejects.toMatchObject({ status: 503 });
  });
});

describe("link", () => {
  test("stores only the encrypted refresh token, syncs at once", async () => {
    const status = await service.link("user", PASSWORD, "Admin");
    expect(status).toMatchObject({ state: "linked", username: "user", syncEnabled: true, lastSyncAt: null, lastError: null, counts: { pins: 0, hints: 0 } });
    const doc = await jotiboardLinkModel(realDb).findOne().lean();
    expect(JSON.stringify(doc)).not.toContain(PASSWORD);
    expect(decryptSession({ ciphertext: doc!.refreshCiphertext, iv: doc!.iv, tag: doc!.tag }, KEY)).toBe("rt-1");
    expect(doc).toMatchObject({ username: "user", uid: "uid-1", linkedBy: "Admin", syncEnabled: true, state: "ok" });
    expect(service.nextPollAt?.getTime()).toBe(clock.getTime());
  });

  test("wrong password → 400 in Dutch, nothing stored", async () => {
    await expect(service.link("user", "nope", "Admin")).rejects.toMatchObject({ status: 400, message: "Ongeldige gebruikersnaam of wachtwoord" });
    expect(await jotiboardLinkModel(realDb).countDocuments()).toBe(0);
  });

  test.each([
    [new JotiboardLoginError("tooMany"), 429, "Te veel pogingen, probeer het later opnieuw"],
    [new JotiboardLoginError("disabled"), 400, "Dit Jotiboard-account is uitgeschakeld"],
    [new JotiboardUpstreamError("down"), 502, "Jotiboard is nu niet bereikbaar, probeer het later opnieuw."],
  ])("%p → %i", async (error, status, message) => {
    client.signInError = error;
    await expect(service.link("user", PASSWORD, "Admin")).rejects.toMatchObject({ status, message });
  });
});

describe("poll", () => {
  beforeEach(async () => {
    await service.link("user", PASSWORD, "Admin");
  });

  test("reads both nodes and hands them to the importer, solves first", async () => {
    client.data.manualLocations = { p1: { foxAreas: ["Bravo"], lat: 52, lon: 5, time: 1, type: "other" } };
    client.data.hintSolves = { "10": { messageId: 10, foxAreas: ["Alpha"], areaCoords: { Alpha: { x: 155000, y: 463000 } }, completed: false } };
    await service.pollOnce();
    expect(importer.pinSnapshots).toEqual([[{ id: "p1", foxAreas: ["Bravo"], lat: 52, lon: 5, time: 1, type: "other" }]]);
    expect(importer.solveSnapshots[0]).toHaveLength(1);
    expect(await service.status()).toMatchObject({ lastSyncAt: clock.toISOString(), lastError: null });
    expect(service.nextPollAt?.getTime()).toBe(clock.getTime() + POLL_INTERVAL_MS);
  });

  test("refreshes the ID token 5 min before it expires", async () => {
    await service.pollOnce();
    expect(client.calls.filter((call) => call.startsWith("refresh"))).toEqual([]);
    advance(56 * 60_000);
    await service.pollOnce();
    expect(client.calls).toContain("refresh rt-1");
    expect(client.calls).toContain("read hintSolves id-2");
    const doc = await jotiboardLinkModel(realDb).findOne().lean();
    expect(decryptSession({ ciphertext: doc!.refreshCiphertext, iv: doc!.iv, tag: doc!.tag }, KEY)).toBe("rt-2");
  });

  test("auth error → loggedOut, polling stops, link kept", async () => {
    client.readError = new JotiboardAuthError();
    await service.pollOnce();
    expect(await service.status()).toMatchObject({ state: "loggedOut", username: "user" });
    expect(service.nextPollAt).toBeNull();
    expect((await jotiboardLinkModel(realDb).findOne().lean())?.state).toBe("reauth");
    // Logging in again fixes it
    client.readError = null;
    expect(await service.link("user", PASSWORD, "Admin")).toMatchObject({ state: "linked" });
  });

  test("network error → lastError, keeps polling", async () => {
    client.readError = new JotiboardUpstreamError("down");
    await service.pollOnce();
    expect(await service.status()).toMatchObject({ state: "linked", lastError: "Jotiboard niet bereikbaar, probeert opnieuw" });
    expect(service.nextPollAt?.getTime()).toBe(clock.getTime() + POLL_INTERVAL_MS);
  });

  test("logging in again while a poll is in flight keeps the poller going", async () => {
    await service.stop();
    service = createService({ autoPoll: true });
    await service.start();
    let release!: () => void;
    client.readGate = new Promise<void>((resolve) => (release = resolve));
    await service.link("user", PASSWORD, "Admin");
    while (!client.calls.some((call) => call.startsWith("read"))) await Bun.sleep(1);
    await service.link("user", PASSWORD, "Admin");
    await Bun.sleep(5);
    client.readGate = null;
    release();
    for (let i = 0; i < 100 && !importer.pinSnapshots.length; i++) await Bun.sleep(5);
    // 0 = the poller stalled; queued timer polls may each run once, one after the other
    expect(importer.pinSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(client.calls).toContain("read manualLocations id-3");
  });

  test("demo mode switched on while Jotiboard is read: nothing is imported", async () => {
    let release!: () => void;
    client.readGate = new Promise<void>((resolve) => (release = resolve));
    const poll = service.pollOnce();
    while (!client.calls.some((call) => call.startsWith("read"))) await Bun.sleep(1);
    setDemoModeFlag(true);
    try {
      release();
      await poll;
      expect(importer.solveSnapshots).toEqual([]);
      expect(importer.pinSnapshots).toEqual([]);
      expect((await service.status()) as { lastSyncAt: string | null }).toMatchObject({ lastSyncAt: null });
    } finally {
      setDemoModeFlag(false);
      client.readGate = null;
    }
  });

  test("importer error → generic lastError", async () => {
    importer.importError = new Error("db down");
    await service.pollOnce();
    expect(await service.status()).toMatchObject({ lastError: "Synchroniseren mislukt, probeert opnieuw" });
  });
});

describe("sync toggle, unlink, purge, restart", () => {
  beforeEach(async () => {
    await service.link("user", PASSWORD, "Admin");
  });

  test("off: no polling; on: polls at once", async () => {
    expect(await service.setSyncEnabled(false)).toMatchObject({ syncEnabled: false });
    expect(service.nextPollAt).toBeNull();
    await service.pollOnce();
    expect(importer.pinSnapshots).toEqual([]);
    await service.setSyncEnabled(true);
    expect(service.nextPollAt?.getTime()).toBe(clock.getTime());
  });

  test("unlink removes the link, keeps the imports", async () => {
    importer.current = { pins: 3, hints: 1 };
    expect(await service.unlink()).toEqual({ state: "unlinked", counts: { pins: 3, hints: 1 } });
    expect(await jotiboardLinkModel(realDb).countDocuments()).toBe(0);
    expect(importer.purged).toBe(0);
  });

  test("purge removes the imports and turns sync off", async () => {
    importer.current = { pins: 5, hints: 2 };
    const result = await service.purge();
    expect(result.removed).toEqual({ markers: 5, hints: 2 });
    expect(result.status).toMatchObject({ state: "linked", syncEnabled: false, counts: { pins: 0, hints: 0 } });
    expect((await jotiboardLinkModel(realDb).findOne().lean())?.syncEnabled).toBe(false);
  });

  test("purge is refused in demo mode", async () => {
    importer.current = { pins: 5, hints: 2 };
    setDemoModeFlag(true);
    try {
      await expect(service.purge()).rejects.toMatchObject({ status: 409, message: "Data verwijderen kan niet in demomodus." });
    } finally {
      setDemoModeFlag(false);
    }
    expect(importer.purged).toBe(0);
    expect((await jotiboardLinkModel(realDb).findOne().lean())?.syncEnabled).toBe(true);
  });

  test("purge without a link still works", async () => {
    await service.unlink();
    importer.current = { pins: 1, hints: 0 };
    expect((await service.purge()).status).toEqual({ state: "unlinked", counts: { pins: 0, hints: 0 } });
  });

  test("a restart resumes from the stored link", async () => {
    await service.stop();
    const again = createService();
    await again.start();
    expect(await again.status()).toMatchObject({ state: "linked", username: "user", syncEnabled: true });
    expect(again.nextPollAt?.getTime()).toBe(clock.getTime());
    await again.pollOnce();
    expect(client.calls).toContain("refresh rt-1");
    await again.stop();
  });

  test("a stored link with another key → loggedOut", async () => {
    await service.stop();
    const other = createService({ config: { sessionKey: randomBytes(32).toString("base64") } });
    await other.start();
    expect(await other.status()).toMatchObject({ state: "loggedOut" });
    await other.stop();
  });
});
