import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { isObjectIdString } from "../utils/mongo";
import { publicAppUrl } from "./config";
import { sha256 } from "./hash";
import { qrLogins, type QrLoginDoc } from "./models";

export const QR_TTL_MS = 2 * 60 * 1000;

export type QrPoll =
  | { status: "waiting" | "denied" | "expired"; expiresAt: Date }
  | { status: "scanned"; scannedBy: { name: string }; expiresAt: Date }
  | { status: "approved"; userId: Types.ObjectId; label: string };

export async function createQrLogin(requester: { label: string; location: string | null }, now = new Date()) {
  const code = randomBytes(18).toString("base64url");
  const pollSecret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + QR_TTL_MS);
  const doc = await qrLogins().create({ codeHash: sha256(code), pollSecretHash: sha256(pollSecret), status: "waiting", requester, createdAt: now, expiresAt });
  return { id: String(doc._id), code, pollSecret, url: `${publicAppUrl()}/l/${code}`, expiresAt };
}

/** The laptop's view; null for an unknown id or wrong secret. An approval is handed over once (the document is deleted). */
export async function pollQrLogin(id: string, pollSecret: string, now = new Date()): Promise<QrPoll | null> {
  if (!isObjectIdString(id)) return null;
  const filter = { _id: id, pollSecretHash: sha256(pollSecret) };
  const doc = await qrLogins().findOne(filter).lean<QrLoginDoc>();
  if (!doc) return null;
  if (doc.status === "approved") {
    const taken = await qrLogins().findOneAndDelete({ ...filter, status: "approved" }).lean<QrLoginDoc>();
    return taken?.scannedBy ? { status: "approved", userId: taken.scannedBy, label: taken.requester.label } : null;
  }
  if (doc.status === "denied") return { status: "denied", expiresAt: doc.expiresAt };
  if (doc.expiresAt.getTime() <= now.getTime()) return { status: "expired", expiresAt: doc.expiresAt };
  if (doc.status === "scanned") return { status: "scanned", scannedBy: { name: doc.scannedByName ?? "" }, expiresAt: doc.expiresAt };
  return { status: "waiting", expiresAt: doc.expiresAt };
}

/**
 * The phone scanned the code: store its passkey challenge and give it 2 fresh minutes. The same user may scan again
 * (a reload replaces the challenge); "taken" when another user already scanned it.
 */
export async function scanQrLogin(code: string, user: { _id: Types.ObjectId; name: string }, challenge: string, now = new Date()) {
  const codeHash = sha256(code);
  const live = { codeHash, expiresAt: { $gt: now } };
  const doc = await qrLogins()
    .findOneAndUpdate(
      { ...live, $or: [{ status: "waiting" }, { status: "scanned", scannedBy: user._id }] },
      { $set: { status: "scanned", scannedBy: user._id, scannedByName: user.name, challenge, expiresAt: new Date(now.getTime() + QR_TTL_MS) } },
      { returnDocument: "after" },
    )
    .lean<QrLoginDoc>();
  if (doc) return { ok: true as const, requester: { label: doc.requester.label, location: doc.requester.location ?? null }, createdAt: doc.createdAt };
  const taken = await qrLogins().exists({ ...live, status: "scanned" });
  return { ok: false as const, reason: taken ? ("taken" as const) : ("gone" as const) };
}

export function findScannedQrLogin(code: string, userId: Types.ObjectId, now = new Date()) {
  return qrLogins().findOne({ codeHash: sha256(code), status: "scanned", scannedBy: userId, expiresAt: { $gt: now } }).lean<QrLoginDoc>();
}

/** After the passkey checked out: atomically, so one challenge approves once. */
export async function approveQrLogin(code: string, userId: Types.ObjectId, challenge: string, now = new Date()): Promise<boolean> {
  const doc = await qrLogins().findOneAndUpdate(
    { codeHash: sha256(code), status: "scanned", scannedBy: userId, challenge, expiresAt: { $gt: now } },
    { $set: { status: "approved", challenge: null } },
  );
  return doc !== null;
}

export async function denyQrLogin(code: string, userId: Types.ObjectId, now = new Date()): Promise<boolean> {
  const doc = await qrLogins().findOneAndUpdate(
    { codeHash: sha256(code), status: "scanned", scannedBy: userId, expiresAt: { $gt: now } },
    { $set: { status: "denied", challenge: null } },
  );
  return doc !== null;
}
