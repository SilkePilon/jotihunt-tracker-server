import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { qrLogins } from "./models";
import { approveQrLogin, createQrLogin, denyQrLogin, findScannedQrLogin, pollQrLogin, QR_TTL_MS, scanQrLogin } from "./qr-login";

process.env.PUBLIC_APP_URL = "https://jotihunt.test";
// Compile the model before connectTestDb syncs the indexes
qrLogins();

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const requester = { label: "Firefox op Linux", location: "Arnhem" };
const jesse = { _id: new mongoose.Types.ObjectId(), name: "Jesse" };
const noor = { _id: new mongoose.Types.ObjectId(), name: "Noor" };
const t0 = new Date("2026-10-17T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("QR login", () => {
  test("create: a link with the code; code and poll secret are only stored hashed", async () => {
    const qr = await createQrLogin(requester, t0);
    expect(qr.url).toBe(`https://jotihunt.test/l/${qr.code}`);
    expect(qr.expiresAt).toEqual(at(QR_TTL_MS));
    const stored = JSON.stringify(await qrLogins().findById(qr.id).lean());
    expect(stored).not.toContain(qr.code);
    expect(stored).not.toContain(qr.pollSecret);
    expect(await pollQrLogin(qr.id, qr.pollSecret, at(1000))).toEqual({ status: "waiting", expiresAt: at(QR_TTL_MS) });
  });

  test("poll with a wrong secret or a malformed id is null", async () => {
    const qr = await createQrLogin(requester, t0);
    expect(await pollQrLogin(qr.id, "wrong", at(1000))).toBeNull();
    expect(await pollQrLogin("nope", qr.pollSecret, at(1000))).toBeNull();
  });

  test("scan: scanned with the name and a fresh 2 minutes; the same user may scan again, another user gets taken", async () => {
    const qr = await createQrLogin(requester, t0);
    const scan = await scanQrLogin(qr.code, jesse, "challenge-1", at(60_000));
    expect(scan).toEqual({ ok: true, requester, createdAt: t0 });
    expect(await pollQrLogin(qr.id, qr.pollSecret, at(61_000))).toEqual({ status: "scanned", scannedBy: { name: "Jesse" }, expiresAt: at(60_000 + QR_TTL_MS) });
    expect((await scanQrLogin(qr.code, jesse, "challenge-2", at(62_000))).ok).toBe(true);
    expect((await findScannedQrLogin(qr.code, jesse._id, at(62_000)))!.challenge).toBe("challenge-2");
    expect(await scanQrLogin(qr.code, noor, "challenge-3", at(63_000))).toEqual({ ok: false, reason: "taken" });
    expect(await scanQrLogin("unknown-code", jesse, "challenge-4", at(63_000))).toEqual({ ok: false, reason: "gone" });
  });

  test("expired codes can not be scanned and poll says expired", async () => {
    const qr = await createQrLogin(requester, t0);
    expect(await scanQrLogin(qr.code, jesse, "challenge-1", at(QR_TTL_MS))).toEqual({ ok: false, reason: "gone" });
    expect(await pollQrLogin(qr.id, qr.pollSecret, at(QR_TTL_MS))).toEqual({ status: "expired", expiresAt: at(QR_TTL_MS) });
  });

  test("approve needs the scanning user and the current challenge; poll hands the approval over once", async () => {
    const qr = await createQrLogin(requester, t0);
    await scanQrLogin(qr.code, jesse, "challenge-1", at(1000));
    expect(await approveQrLogin(qr.code, noor._id, "challenge-1", at(2000))).toBe(false);
    expect(await approveQrLogin(qr.code, jesse._id, "old-challenge", at(2000))).toBe(false);
    expect(await approveQrLogin(qr.code, jesse._id, "challenge-1", at(2000))).toBe(true);
    expect(await approveQrLogin(qr.code, jesse._id, "challenge-1", at(2000))).toBe(false);
    expect(await findScannedQrLogin(qr.code, jesse._id, at(2000))).toBeNull();
    expect(await pollQrLogin(qr.id, "wrong", at(3000))).toBeNull();
    expect(await pollQrLogin(qr.id, qr.pollSecret, at(3000))).toEqual({ status: "approved", userId: jesse._id, label: "Firefox op Linux" });
    expect(await pollQrLogin(qr.id, qr.pollSecret, at(4000))).toBeNull();
  });

  test("deny: only the scanning user, then poll says denied", async () => {
    const qr = await createQrLogin(requester, t0);
    expect(await denyQrLogin(qr.code, jesse._id, at(1000))).toBe(false);
    await scanQrLogin(qr.code, jesse, "challenge-1", at(1000));
    expect(await denyQrLogin(qr.code, noor._id, at(2000))).toBe(false);
    expect(await denyQrLogin(qr.code, jesse._id, at(2000))).toBe(true);
    expect((await pollQrLogin(qr.id, qr.pollSecret, at(3000)))!.status).toBe("denied");
    expect(await approveQrLogin(qr.code, jesse._id, "challenge-1", at(3000))).toBe(false);
  });
});
