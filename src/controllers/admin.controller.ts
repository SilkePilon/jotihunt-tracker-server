import { Request, Response } from "express";
import { User } from "../models/user.model";
import { revokeUserSessions } from "../auth/sessions";
import { deleteAccounts, updateAccounts } from "../auth/user-store";
import { logger } from "../logger";
import { matchedData } from "express-validator";

const LAST_ADMIN = "Er moet minstens één admin overblijven.";

/**
 * Deleting and demoting users run one at a time (single server process), so two admins demoting each other at the
 * same moment can never both pass the "another admin is left" check.
 */
let adminChanges: Promise<unknown> = Promise.resolve();
function serializeAdminChange<T>(change: () => Promise<T>): Promise<T> {
  const result = adminChanges.then(change);
  adminChanges = result.catch(() => undefined);
  return result;
}

/** Whether an admin other than `userId` exists. */
async function hasOtherAdmin(userId: string) {
  return (await User.exists({ admin: true, _id: { $ne: userId } })) !== null;
}

export async function getUsers(_req: Request, res: Response) {
  const users = await User.find().select("-readArticles -webauthnUserId").lean();
  return res.status(200).json(
    users.map(({ passkeys, ...user }) => ({ ...user, passkeyCount: passkeys?.length ?? 0 })),
  );
}

export async function deleteUser(req: Request, res: Response) {
  const id = String(req.params.id);

  try {
    const result = await serializeAdminChange(async () => {
      const user = await User.findById(id, { admin: 1 }).lean();
      if (!user) return "not-found";
      if (user.admin && !(await hasOtherAdmin(id))) return "last-admin";
      // Also in the live edition's database while an archive is shown, with the push subscriptions
      await deleteAccounts({ _id: id });
      return "deleted";
    });
    if (result === "not-found") return res.status(404).json({ message: "User not found" });
    if (result === "last-admin") return res.status(409).json({ message: LAST_ADMIN });
    await revokeUserSessions(id);

    return res.status(200).json({ message: "User deleted" });
  } catch (error) {
    logger.error("Error deleting user", error);
    return res.status(500).json({ message: "Error deleting user" });
  }
}

export async function updateUser(req: Request, res: Response) {
  const id = String(req.params.id);
  const data = matchedData(req);

  try {
    const result = await serializeAdminChange(async () => {
      const user = await User.findById(id, { admin: 1 }).lean();
      if (!user) return "not-found";
      if (data.admin === false && user.admin && !(await hasOtherAdmin(id))) return "last-admin";
      const set: Record<string, unknown> = {};
      if (data.name) set.name = data.name;
      if (data.admin !== undefined) set.admin = data.admin;
      // Also in the live edition's database while an archive is shown
      if (Object.keys(set).length > 0) await updateAccounts({ _id: id }, { $set: set });
      return User.findById(id);
    });
    if (result === "not-found") return res.status(404).json({ message: "User not found" });
    if (result === "last-admin") return res.status(409).json({ message: LAST_ADMIN });
    return res.status(200).json(result);
  } catch (error) {
    logger.error("Error updating user", error);
    return res.status(500).json({ message: "Error updating user" });
  }
}
