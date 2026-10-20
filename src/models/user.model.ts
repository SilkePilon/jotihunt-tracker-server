import { randomBytes } from "node:crypto";
import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { VEHICLES } from "../services/tracker-onboarding.helpers";

/** The user's own Traccar device (created lazily by GET /tracker/me). */
const TrackerSchema = new mongoose.Schema(
  {
    deviceId: { type: Number, required: true },
    uniqueId: { type: String, required: true },
    vehicle: { type: String, enum: VEHICLES, required: true },
  },
  { _id: false },
);

/** A paired phone (Android app). Its device token carries `did` = `id`; removing the entry revokes the token. */
const DeviceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: false, default: null },
  },
  { _id: false },
);

/** A WebAuthn credential (passkey) of the user */
const PasskeySchema = new mongoose.Schema({
  /** base64url credential id */
  credentialId: { type: String, required: true },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  transports: { type: [String], default: [] },
  /** "Chrome op Android"; renamable later */
  name: { type: String, required: true },
  createdAt: { type: Date, required: true },
  lastUsedAt: { type: Date, default: null },
});

/** Random WebAuthn user handle (never the Mongo id), base64url of 32 bytes */
export function newWebauthnUserId(): string {
  return randomBytes(32).toString("base64url");
}

export const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  admin: { type: Boolean, default: false, required: true },
  webauthnUserId: { type: String, required: true, default: newWebauthnUserId },
  passkeys: { type: [PasskeySchema], default: [] },
  /** The invite the account was made with (null: CLI or from before invites) */
  invite: { type: mongoose.Schema.Types.ObjectId, default: null },
  lastActiveAt: { type: Date, default: null },
  /** Highest onboarding tour version this user has seen (client TOUR_VERSION); 0 = never. */
  tutorialVersion: {
    type: Number,
    default: 0,
    required: true,
  },
  /** Opt-out notification settings, shared by all of the user's devices (push) and in-app sounds */
  notificationPrefs: {
    disabledTypes: { type: [String], required: true, default: [] },
    /** Highest "Meldingen" dialog version shown (client NOTIFICATIONS_PROMPT_VERSION); 0 = never */
    promptedVersion: { type: Number, required: true, default: 0 },
  },
  /** Ids of the news and assignment articles this user opened on the hints page */
  readArticles: {
    type: [Number],
    default: [],
  },
  tracker: {
    type: TrackerSchema,
    required: false,
  },
  /** Phones paired with the Android app, sorted by lastSeenAt (least recently seen first) when a phone is paired */
  devices: {
    type: [DeviceSchema],
    default: [],
  },
});

// A passkey belongs to one account. Partial: users without passkeys have no entry in the index.
UserSchema.index({ "passkeys.credentialId": 1 }, { unique: true, partialFilterExpression: { "passkeys.credentialId": { $exists: true } } });

// Never send key material, the WebAuthn handle or the read state (only served by GET /articles/read) to clients
UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.passkeyCount = Array.isArray(ret.passkeys) ? ret.passkeys.length : 0;
    delete ret.passkeys;
    delete ret.webauthnUserId;
    delete ret.readArticles;
    return ret;
  },
});

export const User = mongoose.model("User", UserSchema);
export type UserType = HydratedDocument<InferSchemaType<typeof UserSchema>>;
