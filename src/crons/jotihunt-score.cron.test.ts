import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { SiteScore } from "../models/site-score.model";
import { recordScore, recordScoreFailure, scoreView } from "../services/score-sync.service";
import type { SiteScore as ParsedScore } from "../services/jotihunt-score.parse";
import { initAppConfig, resetAppConfig } from "../settings/app-config";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import syncJotihuntScore from "./jotihunt-score.cron";

const LOGIN = { JOTIHUNT_WEB_USERNAME: "team@example.nl", JOTIHUNT_WEB_PASSWORD: "hunter2" };
const score = (total: number | null, hunts = 0): ParsedScore => ({ total, parts: { hunts, counterHunts: 0, assignments: 0, photoAssignments: 0, hints: null, penalty: 0 } });
const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 18, minute));

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await initAppConfig(mongoose.connection, LOGIN);
});
afterAll(async () => {
  resetAppConfig();
  await disconnectTestDb();
});

describe("score bookkeeping", () => {
  test("nothing read yet: nulls everywhere", async () => {
    expect(await scoreView()).toEqual({
      configured: true,
      lastSuccessAt: null,
      lastError: null,
      total: null,
      parts: { hunts: null, counterHunts: null, assignments: null, photoAssignments: null, hints: null, penalty: null },
      previousTotal: null,
      changedAt: null,
    });
  });

  test("the first read sets no change; a changed total keeps the old one and the time", async () => {
    await recordScore(score(0), at(0));
    expect(await scoreView()).toMatchObject({ total: 0, previousTotal: null, changedAt: null, lastSuccessAt: at(0).toISOString() });

    await recordScore(score(0, 0), at(2));
    expect(await scoreView()).toMatchObject({ total: 0, previousTotal: null, changedAt: null, lastSuccessAt: at(2).toISOString() });

    await recordScore(score(145, 70), at(4));
    expect(await scoreView()).toMatchObject({ total: 145, parts: { hunts: 70, hints: null }, previousTotal: 0, changedAt: at(4).toISOString() });

    // Same total, other parts: no new change
    await recordScore(score(145, 60), at(6));
    expect(await scoreView()).toMatchObject({ total: 145, parts: { hunts: 60 }, previousTotal: 0, changedAt: at(4).toISOString(), lastSuccessAt: at(6).toISOString() });
  });

  test("a failure keeps the score and sets a Dutch error; the next success clears it", async () => {
    await recordScore(score(10), at(0));
    await recordScoreFailure(new Error("Login failed (POST /login → back to /login)"), at(2));
    expect(await scoreView()).toMatchObject({ total: 10, lastError: "Inloggen bij jotihunt.nl mislukt", lastSuccessAt: at(0).toISOString() });
    expect((await SiteScore.findOne().lean())!.lastAttemptAt).toEqual(at(2));

    await recordScore(score(10), at(4));
    expect(await scoreView()).toMatchObject({ lastError: null, lastSuccessAt: at(4).toISOString(), changedAt: null });
  });

  test("a failure before any read is no first read", async () => {
    await recordScoreFailure(new Error("timeout"), at(0));
    await recordScore(score(5), at(2));
    expect(await scoreView()).toMatchObject({ total: 5, previousTotal: null, changedAt: null, lastError: null });
  });
});

describe("score cron", () => {
  test("does nothing without a jotihunt.nl login", async () => {
    await initAppConfig(mongoose.connection, {});
    let reads = 0;
    await syncJotihuntScore({ read: async () => (reads++, score(1)) });
    expect(reads).toBe(0);
    expect(await SiteScore.countDocuments()).toBe(0);
    expect((await scoreView()).configured).toBe(false);
  });

  test("stores what it read", async () => {
    await syncJotihuntScore({ read: async () => score(42) });
    expect(await scoreView()).toMatchObject({ total: 42, lastError: null, lastSuccessAt: expect.any(String) });
  });

  test("a failed read is stored as lastError and never thrown", async () => {
    await syncJotihuntScore({
      read: async () => {
        throw new Error("No score card on the dashboard");
      },
    });
    expect(await scoreView()).toMatchObject({ total: null, lastError: "jotihunt.nl ziet er anders uit", lastSuccessAt: null });
  });
});
