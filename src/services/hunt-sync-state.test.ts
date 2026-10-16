import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Connection } from "mongoose";
import { initAppConfig, resetAppConfig } from "../settings/app-config";
import { markSyncFailure, markSyncStart, markSyncSuccess, resetSyncState, syncErrorText, syncStateView } from "./hunt-sync-state";

function fakeConnection(): Connection {
  const collection = { findOne: async () => null, updateOne: async () => undefined };
  return { collection: () => collection } as unknown as Connection;
}

beforeEach(async () => {
  resetSyncState();
  await initAppConfig(fakeConnection(), { JOTIHUNT_WEB_USERNAME: "team@example.nl", JOTIHUNT_WEB_PASSWORD: "hunter2" });
});
afterAll(resetAppConfig);

describe("hunt sync state", () => {
  test("starts empty", () => {
    expect(syncStateView()).toEqual({ configured: true, running: false, lastSuccessAt: null, lastAttemptAt: null, lastError: null });
  });

  test("not configured without a jotihunt.nl login", async () => {
    await initAppConfig(fakeConnection(), {});
    expect(syncStateView().configured).toBe(false);
  });

  test("a run: running, then success", () => {
    const start = new Date("2026-10-17T19:00:00Z");
    markSyncStart(start);
    expect(syncStateView()).toMatchObject({ running: true, lastAttemptAt: start.toISOString(), lastSuccessAt: null });
    const done = new Date("2026-10-17T19:00:05Z");
    markSyncSuccess(done);
    expect(syncStateView()).toMatchObject({ running: false, lastAttemptAt: start.toISOString(), lastSuccessAt: done.toISOString(), lastError: null });
  });

  test("a failure keeps the last success and sets a short Dutch error; the next success clears it", () => {
    markSyncStart(new Date("2026-10-17T19:00:00Z"));
    markSyncSuccess(new Date("2026-10-17T19:00:05Z"));
    markSyncStart(new Date("2026-10-17T19:01:00Z"));
    markSyncFailure(new Error("Scraping took longer than 120 s"), new Date("2026-10-17T19:03:00Z"));
    expect(syncStateView()).toMatchObject({ running: false, lastSuccessAt: "2026-10-17T19:00:05.000Z", lastAttemptAt: "2026-10-17T19:01:00.000Z", lastError: "jotihunt.nl reageert niet" });
    markSyncStart(new Date("2026-10-17T19:04:00Z"));
    markSyncSuccess(new Date("2026-10-17T19:04:03Z"));
    expect(syncStateView().lastError).toBeNull();
  });

  test("error texts", () => {
    const timeout = new Error("Navigation timeout of 30000 ms exceeded");
    timeout.name = "TimeoutError";
    expect(syncErrorText(timeout)).toBe("jotihunt.nl reageert niet");
    expect(syncErrorText(new Error("net::ERR_NAME_NOT_RESOLVED at https://jotihunt.nl/hunts"))).toBe("jotihunt.nl reageert niet");
    expect(syncErrorText(new Error("Login failed"))).toBe("Inloggen bij jotihunt.nl mislukt");
    expect(syncErrorText(new Error("No Jotihunt website login set"))).toBe("Inloggen bij jotihunt.nl mislukt");
    expect(syncErrorText(new Error("No hunts page on https://jotihunt.nl/hunts"))).toBe("Synchroniseren mislukt");
    expect(syncErrorText("weird")).toBe("Synchroniseren mislukt");
  });
});
