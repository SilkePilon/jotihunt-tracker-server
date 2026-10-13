import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { publicAppUrl } from "./config";
import { sha256 } from "./hash";
import { recoveryLinks, type RecoveryLinkDoc } from "./models";

export const RECOVERY_TTL_MS = 60 * 60 * 1000;

export async function createRecoveryLink(userId: unknown, createdBy: unknown | null, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + RECOVERY_TTL_MS);
  await recoveryLinks().create({ tokenHash: sha256(token), user: userId as Types.ObjectId, createdBy: createdBy as Types.ObjectId | null, createdAt: now, expiresAt, usedAt: null });
  return { url: `${publicAppUrl()}/herstel/${token}`, token, expiresAt };
}

export function findRecoveryLink(token: string, now = new Date()) {
  return recoveryLinks().findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } }).lean<RecoveryLinkDoc>();
}

/** Mark the link used (atomically, so two tabs can not both use it); null when it no longer works. */
export function useRecoveryLink(token: string, now = new Date()) {
  return recoveryLinks()
    .findOneAndUpdate({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { returnDocument: "after" })
    .lean<RecoveryLinkDoc>();
}
