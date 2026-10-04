import mongoose from "mongoose";
import { ServiceError } from "../http/service-error";
import { User } from "../models/user.model";

type Id = mongoose.Types.ObjectId | string;

/** What a guarded write would overwrite */
export type ConflictKind = "answer" | "claim" | "status" | "owner";

/** True when someone other than `userId` set the current value */
export const setByOther = (writer: Id | null | undefined, userId: Id) => !!writer && String(writer) !== String(userId);

/**
 * The 409 for a write that would overwrite someone else's value. The client shows `conflict` to the user and
 * repeats the write with `overwrite: true` when they confirm.
 */
export async function conflictError(
  message: string,
  kind: ConflictKind,
  value: string | null | undefined,
  writer: Id | null | undefined,
  at: Date | null | undefined,
  details: Record<string, unknown> = {},
) {
  const user = writer ? await User.findById(writer, { name: 1 }).lean() : null;
  const by = user ? { _id: String(user._id), name: user.name } : null;
  return new ServiceError(409, message, { ...details, conflict: { kind, value: value ?? null, by, at: at ?? null } });
}
