import mongoose, { type Model } from "mongoose";
import { isDemoMode } from "../demo/demo-mode";
import { newWebauthnUserId, User, UserSchema, type UserType } from "../models/user.model";
import { authConnection } from "./auth-db";

export interface PasskeyFields {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  name: string;
}

/**
 * The users collections an account change must reach: the current database, plus the real one while demo mode is on
 * (the demo database is thrown away when demo mode ends, accounts made meanwhile must survive).
 */
function userModels(): Model<unknown>[] {
  const real = authConnection();
  if (!isDemoMode() || real === mongoose.connection) return [User as unknown as Model<unknown>];
  const realUser = (real.models.User ?? real.model("User", UserSchema)) as unknown as Model<unknown>;
  return [User as unknown as Model<unknown>, realUser];
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
  // Real database first: when that fails (e.g. duplicate passkey) nothing is left half-created in the demo database
  for (const model of userModels().reverse()) await model.create(doc);
  return (await User.findById(doc._id))!;
}

/**
 * Update the account in the current database, then (in demo mode) the same in the real one. When the current
 * database matched nothing the real one is left alone, so a conditional filter (e.g. "a second passkey exists")
 * decides once and both databases stay in step. Resolves to whether the current database matched.
 */
export async function updateAccounts(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<boolean> {
  const [current, ...others] = userModels();
  const result = await current.updateOne(filter, update);
  if (result.matchedCount === 0) return false;
  for (const model of others) await model.updateOne(filter, update);
  return true;
}
