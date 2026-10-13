import mongoose, { type Types } from "mongoose";
import { authModel } from "./auth-db";

export const SESSION_VIAS = ["passkey", "invite", "herstel", "qr", "cli"] as const;
export type SessionVia = (typeof SESSION_VIAS)[number];

/** A web login (one browser). The token is a JWT carrying this document's id; deleting it logs that browser out. */
export interface SessionDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  /** "Firefox op Linux" */
  label: string;
  via: SessionVia;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

const SessionSchema = new mongoose.Schema<SessionDoc>(
  {
    user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    label: { type: String, required: true },
    via: { type: String, enum: SESSION_VIAS, required: true },
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    // MongoDB removes expired sessions by itself
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false },
);

export interface InviteDoc {
  _id: Types.ObjectId;
  code: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const InviteSchema = new mongoose.Schema<InviteDoc>(
  {
    code: { type: String, required: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    maxUses: { type: Number, default: null },
    uses: { type: Number, required: true, default: 0 },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

/** One-time link that adds a new passkey to an account (lost phone, or the switch away from passwords). */
export interface RecoveryLinkDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  user: Types.ObjectId;
  /** null when made with the CLI */
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

const RecoveryLinkSchema = new mongoose.Schema<RecoveryLinkDoc>(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, required: true },
    // Kept one day after expiry, then removed by MongoDB
    expiresAt: { type: Date, required: true, index: { expires: 24 * 60 * 60 } },
    usedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

export const CHALLENGE_KINDS = ["login", "register", "add-passkey"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

/** A WebAuthn challenge between the options and verify calls (5 minutes, used once). */
export interface AuthChallengeDoc {
  _id: Types.ObjectId;
  kind: ChallengeKind;
  challenge: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
}

const AuthChallengeSchema = new mongoose.Schema<AuthChallengeDoc>(
  {
    kind: { type: String, enum: CHALLENGE_KINDS, required: true },
    challenge: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false, minimize: false },
);

/** `{ key: "invites" }` in the settings collection: all invite links paused. */
export interface InviteSettingDoc {
  key: string;
  paused: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const InviteSettingSchema = new mongoose.Schema<InviteSettingDoc>(
  {
    key: { type: String, required: true, unique: true },
    paused: { type: Boolean, required: true, default: false },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { collection: "settings", versionKey: false },
);

export const sessions = () => authModel<SessionDoc>("Session", SessionSchema);
export const invites = () => authModel<InviteDoc>("Invite", InviteSchema);
export const recoveryLinks = () => authModel<RecoveryLinkDoc>("RecoveryLink", RecoveryLinkSchema);
export const authChallenges = () => authModel<AuthChallengeDoc>("AuthChallenge", AuthChallengeSchema);
export const inviteSettings = () => authModel<InviteSettingDoc>("InviteSetting", InviteSettingSchema);
