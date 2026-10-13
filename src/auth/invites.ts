import { randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { isDuplicateKeyError } from "../utils/mongo";
import { publicAppUrl } from "./config";
import { invites, type InviteDoc } from "./models";

const MINUTE = 60 * 1000;
export const INVITE_EXPIRY = {
  "30m": 30 * MINUTE,
  "1h": 60 * MINUTE,
  "6h": 6 * 60 * MINUTE,
  "12h": 12 * 60 * MINUTE,
  "1d": 24 * 60 * MINUTE,
  "7d": 7 * 24 * 60 * MINUTE,
  never: null,
} as const satisfies Record<string, number | null>;
export type InviteExpiry = keyof typeof INVITE_EXPIRY;
export const INVITE_EXPIRY_KEYS = Object.keys(INVITE_EXPIRY) as InviteExpiry[];
export const INVITE_MAX_USES = [1, 5, 10, 25, 50, 100] as const;

/** No 0/O, 1/I/L or U: codes are read aloud and typed over at HQ */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Stopped invites stay in the admin list this long */
const SHOW_STOPPED_MS = 24 * 60 * MINUTE;

export type InviteState = "active" | "expired" | "revoked" | "full";
export type InviteBlock = Exclude<InviteState, "active"> | "paused" | "unknown";

export function newInviteCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

export function normalizeInviteCode(code: string): string {
  return String(code).trim().toUpperCase();
}

export function inviteUrl(code: string): string {
  return `${publicAppUrl()}/invite/${code}`;
}

export function inviteState(invite: Pick<InviteDoc, "revokedAt" | "expiresAt" | "maxUses" | "uses">, now = new Date()): InviteState {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return "expired";
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return "full";
  return "active";
}

export async function createInvite({ createdBy, expiry, maxUses }: { createdBy: Types.ObjectId; expiry: InviteExpiry; maxUses: number | null }, now = new Date()): Promise<InviteDoc> {
  const ttl = INVITE_EXPIRY[expiry];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const doc = await invites().create({
        code: newInviteCode(),
        createdBy,
        createdAt: now,
        expiresAt: ttl === null ? null : new Date(now.getTime() + ttl),
        maxUses,
        uses: 0,
        lastUsedAt: null,
        revokedAt: null,
      });
      return doc.toObject();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new Error("Could not create a unique invite code");
}

export function findInvite(code: string) {
  return invites().findOne({ code: normalizeInviteCode(code) }).lean<InviteDoc>();
}

/** Atomically use the invite once; null when it is unknown, revoked, expired or full. */
export function claimInviteUse(code: string, now = new Date()) {
  return invites()
    .findOneAndUpdate(
      {
        code: normalizeInviteCode(code),
        revokedAt: null,
        $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { $or: [{ maxUses: null }, { $expr: { $lt: ["$uses", "$maxUses"] } }] }],
      },
      { $inc: { uses: 1 }, $set: { lastUsedAt: now } },
      { returnDocument: "after" },
    )
    .lean<InviteDoc>();
}

/** Give a use back when the account could not be created after claiming it. */
export async function releaseInviteUse(id: Types.ObjectId): Promise<void> {
  await invites().updateOne({ _id: id, uses: { $gt: 0 } }, { $inc: { uses: -1 } });
}

export function revokeInvite(id: Types.ObjectId | string, now = new Date()) {
  return invites().findOneAndUpdate({ _id: id, revokedAt: null }, { $set: { revokedAt: now } }, { returnDocument: "after" }).lean<InviteDoc>();
}

function stoppedAt(invite: InviteDoc, state: InviteState): Date {
  if (state === "revoked") return invite.revokedAt!;
  if (state === "expired") return invite.expiresAt!;
  return invite.lastUsedAt ?? invite.createdAt;
}

/** Newest first; invites that stopped working more than a day ago are left out. */
export async function listInvites(now = new Date()): Promise<InviteDoc[]> {
  const all = await invites().find({}).sort({ createdAt: -1 }).lean<InviteDoc[]>();
  return all.filter((invite) => {
    const state = inviteState(invite, now);
    return state === "active" || now.getTime() - stoppedAt(invite, state).getTime() < SHOW_STOPPED_MS;
  });
}
