import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { claimInviteUse, createInvite, inviteState, listInvites, newInviteCode, normalizeInviteCode, revokeInvite } from "./invites";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const admin = new mongoose.Types.ObjectId();
const t0 = new Date("2026-10-14T10:00:00Z");
const hours = (n: number) => new Date(t0.getTime() + n * 60 * 60 * 1000);

describe("codes", () => {
  test("8 characters without ambiguous ones", () => {
    for (let i = 0; i < 200; i++) expect(newInviteCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  });
  test("normalize trims and uppercases", () => {
    expect(normalizeInviteCode(" k7p4qxab ")).toBe("K7P4QXAB");
  });
});

describe("state", () => {
  test("active, expired, revoked, full", async () => {
    const invite = await createInvite({ createdBy: admin, expiry: "1d", maxUses: 2 }, t0);
    expect(inviteState(invite, t0)).toBe("active");
    expect(inviteState(invite, hours(24))).toBe("expired");
    expect(inviteState({ ...invite, revokedAt: t0 }, t0)).toBe("revoked");
    expect(inviteState({ ...invite, uses: 2 }, t0)).toBe("full");
  });
  test("never expires and unlimited", async () => {
    const invite = await createInvite({ createdBy: admin, expiry: "never", maxUses: null }, t0);
    expect(invite.expiresAt).toBeNull();
    expect(inviteState({ ...invite, uses: 10_000 }, hours(10_000))).toBe("active");
  });
});

describe("claimInviteUse", () => {
  test("concurrent claims never exceed maxUses", async () => {
    const invite = await createInvite({ createdBy: admin, expiry: "1d", maxUses: 3 }, t0);
    const results = await Promise.all(Array.from({ length: 10 }, () => claimInviteUse(invite.code, t0)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
  test("expired or revoked invites can not be claimed; lowercase codes can", async () => {
    const invite = await createInvite({ createdBy: admin, expiry: "1h", maxUses: null }, t0);
    expect(await claimInviteUse(invite.code.toLowerCase(), t0)).not.toBeNull();
    expect(await claimInviteUse(invite.code, hours(2))).toBeNull();
    await revokeInvite(invite._id, t0);
    expect(await claimInviteUse(invite.code, t0)).toBeNull();
  });
});

describe("listInvites", () => {
  test("hides invites that stopped working more than a day ago", async () => {
    const active = await createInvite({ createdBy: admin, expiry: "7d", maxUses: null }, t0);
    const expiredLongAgo = await createInvite({ createdBy: admin, expiry: "30m", maxUses: null }, t0);
    const revokedJustNow = await createInvite({ createdBy: admin, expiry: "7d", maxUses: null }, t0);
    await revokeInvite(revokedJustNow._id, hours(47));
    const codes = (await listInvites(hours(48))).map((invite) => invite.code);
    expect(codes).toContain(active.code);
    expect(codes).toContain(revokedJustNow.code);
    expect(codes).not.toContain(expiredLongAgo.code);
  });
});
