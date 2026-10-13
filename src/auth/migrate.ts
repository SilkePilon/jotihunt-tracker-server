import type mongoose from "mongoose";
import { newWebauthnUserId } from "../models/user.model";

/** One-off switch to passkeys: strip password data, give every user a WebAuthn handle, drop the e-mail index. */
export async function migratePasswordless(connection: mongoose.Connection): Promise<{ cleaned: number; handles: number }> {
  const users = connection.collection("users");
  // Drop the unique e-mail index first: unsetting email on several users would otherwise collide on null
  // A fresh database has no users collection yet
  const existing = await users.indexes().catch((error: { code?: number }) => (error.code === 26 ? [] : Promise.reject(error)));
  if (existing.some((index) => index.name === "email_1")) await users.dropIndex("email_1");
  const cleaned = await users.updateMany(
    { $or: [{ email: { $exists: true } }, { password: { $exists: true } }, { requiresPasswordChange: { $exists: true } }, { passwordChangedAt: { $exists: true } }] },
    { $unset: { email: "", password: "", requiresPasswordChange: "", passwordChangedAt: "" } },
  );
  let handles = 0;
  for (const doc of await users.find({ webauthnUserId: { $exists: false } }, { projection: { _id: 1 } }).toArray()) {
    const result = await users.updateOne({ _id: doc._id, webauthnUserId: { $exists: false } }, { $set: { webauthnUserId: newWebauthnUserId(), passkeys: [] } });
    handles += result.modifiedCount;
  }
  return { cleaned: cleaned.modifiedCount, handles };
}
