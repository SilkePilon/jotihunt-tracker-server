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

let liveOverride: Connection | null | undefined;

/** Tests only: the live edition's connection without initEditions; undefined = back to liveConnection(). */
export function setLiveUsersConnection(connection: Connection | null | undefined) {
  liveOverride = connection;
}

/**
 * The users collections an account change must reach: the shown edition's, plus the live edition's (master copy) when
 * an archive on another database is shown (showing an archive copies the live users over).
 */
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

/**
 * Delete the accounts matching `filter` and their push subscriptions in the shown edition's database and (when an
 * archive on another database is shown) the live one. Resolves to how many accounts the shown database deleted.
 */
export async function deleteAccounts(filter: Record<string, unknown>): Promise<number> {
  let shownDeleted = 0;
  for (const [index, model] of userModels().entries()) {
    const ids = (await model.find(filter, { _id: 1 }).lean<{ _id: mongoose.Types.ObjectId }[]>()).map((user) => user._id);
    if (ids.length === 0) continue;
    const { deletedCount } = await model.deleteMany({ _id: { $in: ids } });
    await model.db.collection("pushsubscriptions").deleteMany({ user: { $in: ids } });
    if (index === 0) shownDeleted = deletedCount;
  }
  return shownDeleted;
}
