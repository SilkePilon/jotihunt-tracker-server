import mongoose, { type Connection, type Model } from "mongoose";
import { newWebauthnUserId, User, UserSchema, type UserType } from "../models/user.model";
import { liveConnection } from "../editions/database-switch";
import { PushSubscription } from "../models/push-subscription.model";

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
  return modelsOf(User as unknown as Model<unknown>, UserSchema);
}

/** `model` on the shown database, plus the same model on the live edition's database when an archive on another one is shown. */
function modelsOf(model: Model<unknown>, schema: mongoose.Schema): Model<unknown>[] {
  const live = liveOverride === undefined ? liveConnection() : liveOverride;
  if (!live || live.name === mongoose.connection.name) return [model];
  const liveModel = (live.models[model.modelName] ?? live.model(model.modelName, schema)) as unknown as Model<unknown>;
  return [model, liveModel];
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

/**
 * Delete push subscriptions in the shown edition's database and (when an archive on another database is shown) the live
 * one, the master copy: unsubscribing in the archive (e.g. on logout) must not leave a stale subscription in live.
 */
export async function deletePushSubscriptions(filter: Record<string, unknown>): Promise<void> {
  for (const model of modelsOf(PushSubscription as unknown as Model<unknown>, PushSubscription.schema)) await model.deleteMany(filter);
}

/**
 * Record that the user has seen the onboarding tour up to `version` (also in the live database while an archive is
 * shown). Never lowers the stored version.
 */
export async function setTutorialVersion(user: UserType, version: number): Promise<number> {
  // $max in the database, so concurrent requests can never lower the stored version
  await updateAccounts({ _id: user._id }, { $max: { tutorialVersion: version } });
  const updated = await User.findById(user._id, { tutorialVersion: 1 }).lean();
  user.tutorialVersion = updated?.tutorialVersion ?? Math.max(user.tutorialVersion ?? 0, version);
  return user.tutorialVersion;
}
