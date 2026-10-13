import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { saveChallenge, takeChallenge } from "./challenges";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const t0 = new Date("2026-10-14T10:00:00Z");

describe("challenges", () => {
  test("a challenge can be taken once, with its payload", async () => {
    const id = await saveChallenge("register", "abc", { name: "Jesse" }, t0);
    expect(await takeChallenge(id, "register", t0)).toEqual({ challenge: "abc", payload: { name: "Jesse" } });
    expect(await takeChallenge(id, "register", t0)).toBeNull();
  });

  test("wrong kind, expired (5 min) or malformed ids are null", async () => {
    const id = await saveChallenge("login", "abc", {}, t0);
    expect(await takeChallenge(id, "register", t0)).toBeNull();
    expect(await takeChallenge(id, "login", new Date(t0.getTime() + 5 * 60 * 1000))).toBeNull();
    expect(await takeChallenge("nope", "login", t0)).toBeNull();
  });
});
