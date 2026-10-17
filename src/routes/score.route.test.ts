import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { User } from "../models/user.model";
import { signDeviceToken } from "../services/access-token";
import { recordScore, recordScoreFailure } from "../services/score-sync.service";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
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

const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("GET /score", () => {
  test("needs a token; a web session and a device token both work", async () => {
    expect((await get("/score")).status).toBe(401);
    const web = tokenFor(await withSession(await User.create({ name: "Hunter" })));
    const phone = await User.create({ name: "Phone", devices: [{ id: "dev-1", name: "Pixel", createdAt: new Date() }] });
    expect((await get("/score", web)).status).toBe(200);
    expect((await get("/score", signDeviceToken(phone, "dev-1"))).status).toBe(200);
  });

  test("the contract shape: nulls before the first read, then the score with its last change", async () => {
    const token = tokenFor(await withSession(await User.create({ name: "Hunter" })));
    expect(await (await get("/score", token)).json()).toEqual({
      configured: expect.any(Boolean),
      lastSuccessAt: null,
      lastError: null,
      total: null,
      parts: { hunts: null, counterHunts: null, assignments: null, photoAssignments: null, hints: null, penalty: null },
      previousTotal: null,
      changedAt: null,
    });

    const parts = { hunts: 70, counterHunts: 20, assignments: 40, photoAssignments: 25, hints: null, penalty: 10 };
    await recordScore({ total: 135, parts }, new Date("2026-10-17T18:00:00Z"));
    await recordScore({ total: 145, parts }, new Date("2026-10-17T18:02:00Z"));
    await recordScoreFailure(new Error("The operation timed out."), new Date("2026-10-17T18:04:00Z"));
    expect(await (await get("/score", token)).json()).toEqual({
      configured: expect.any(Boolean),
      lastSuccessAt: "2026-10-17T18:02:00.000Z",
      lastError: "jotihunt.nl reageert niet",
      total: 145,
      parts,
      previousTotal: 135,
      changedAt: "2026-10-17T18:02:00.000Z",
    });
  });
});
