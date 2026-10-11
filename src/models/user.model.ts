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

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  admin: {
    type: Boolean,
    default: false,
    required: true,
  },
  requiresPasswordChange: {
    type: Boolean,
    default: true,
    required: true,
  },
  /**
   * Last password change (whole seconds, like a JWT's iat). Tokens issued before it are rejected; users stored
   * before this field existed have none, so their tokens stay valid.
   */
  passwordChangedAt: {
    type: Date,
    required: false,
  },
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
  /** Phones paired with the Android app (newest last) */
  devices: {
    type: [DeviceSchema],
    default: [],
  },
});

// Exclude the password and the read state (only served by GET /articles/read) from JSON responses
UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.password;
    delete ret.readArticles;
    return ret;
  },
});

export const User = mongoose.model("User", UserSchema);
export type UserType = HydratedDocument<InferSchemaType<typeof UserSchema>>;

/** Record that the user has seen the onboarding tour up to `version`. Never lowers the stored version. */
export async function setTutorialVersion(user: UserType, version: number): Promise<number> {
  // $max in the database, so concurrent requests can never lower the stored version
  const updated = await User.findOneAndUpdate({ _id: user._id }, { $max: { tutorialVersion: version } }, { returnDocument: "after" });
  user.tutorialVersion = updated?.tutorialVersion ?? Math.max(user.tutorialVersion ?? 0, version);
  return user.tutorialVersion;
}

/**
 * Argon2id with 19 MiB memory and 2 iterations (OWASP minimum). Bun's default (64 MiB) used 2.4 GB of RAM with 50
 * logins at once. Hashes made with other settings still verify (the settings are stored in the hash).
 */
const PASSWORD_HASH_OPTIONS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, PASSWORD_HASH_OPTIONS);
}

/** True for a hash made with other settings (e.g. Bun's default), which login replaces by a cheaper one. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith(`$argon2id$v=19$m=${PASSWORD_HASH_OPTIONS.memoryCost},t=${PASSWORD_HASH_OPTIONS.timeCost},`);
}

/** Now, rounded down to whole seconds: tokens issued in this second or later stay valid. */
export function passwordChangeTime(at = new Date()): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}
