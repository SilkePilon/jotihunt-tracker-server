import mongoose, { type Connection, type Model } from "mongoose";
import { newWebauthnUserId, User, UserSchema, type UserType } from "../models/user.model";
import { liveConnection } from "../editions/database-switch";

export interface PasskeyFields {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  name: string;
}

/**
 * The users collections an account change must reach: the shown edition's, plus the live edition's (master copy) when
 * an archive on another database is shown (showing an archive copies the live users over).
 */
let liveOverride: Connection | null | undefined;

/** Tests only: the live edition's connection without initEditions; undefined = back to liveConnection(). */
export function setLiveUsersConnection(connection: Connection | null | undefined) {
  liveOverride = connection;
}

function userModels(): Model<unknown>[] {
  const live = liveOverride === undefined ? liveConnection() : liveOverride;
  if (!live || live.name === mongoose.connection.name) return [User as unknown as Model<unknown>];
  const liveUser = (live.models.User ?? live.model("User", UserSchema)) as unknown as Model<unknown>;
  return [User as unknown as Model<unknown>, liveUser];
}

export async function createAccount(fields: { name: string; admin?: boolean; invite?: unknown; webauthnUserId?: string; passkey?: PasskeyFields }): Promise<UserType> {
  const now = new Date();
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    name: fields.name,
    admin: fields.admin ?? false,
    invite: fields.invite ?? null,
    webauthnUserId: fields.webauthnUserId ?? newWebauthnUserId(),
    passkeys: fields.passkey ? [{ ...fields.passkey, createdAt: now, lastUsedAt: now }] : [],
    lastActiveAt: now,
  };
  // Live database first: when that fails (e.g. duplicate passkey) nothing is left half-created in the archive's copy
  for (const model of userModels().reverse()) await model.create(doc);
  return (await User.findById(doc._id))!;
}

/**
 * Update the account in the shown edition's database, then (when an archive on another database is shown) the same in
 * the live one. When the shown database matched nothing the live one is left alone, so a conditional filter (e.g. "a
 * second passkey exists") decides once and both databases stay in step. Resolves to whether the shown database matched.
 */
export async function updateAccounts(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<boolean> {
  const [current, ...others] = userModels();
  const result = await current.updateOne(filter, update);
  if (result.matchedCount === 0) return false;
  for (const model of others) await model.updateOne(filter, update);
  return true;
}
