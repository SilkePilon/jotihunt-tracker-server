import { Request, Response } from "express";
import { hashPassword, passwordChangeTime, User } from "../models/user.model";
import { PushSubscription } from "../models/push-subscription.model";
import { logger } from "../logger";
import { matchedData } from "express-validator";
import { isDuplicateKeyError } from "../utils/mongo";

const EMAIL_IN_USE = "E-mailadres is al in gebruik.";
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

export async function getUsers(req: Request, res: Response) {
  const users = await User.find().select("-password").lean();
  return res.status(200).json(users);
}

export async function createUser(req: Request, res: Response) {
  const data = matchedData(req);

  try {
    const hashedPassword = await hashPassword(data.password);
    const user = new User({
      name: data.name,
      email: data.email,
      admin: data.admin ?? false,
      password: hashedPassword,
    });

    await user.save();

    return res.status(201).json(user);
  } catch (error) {
    // The validator checks the address, but two requests at once can both pass it; the unique index decides
    if (isDuplicateKeyError(error)) return res.status(400).json({ message: EMAIL_IN_USE });
    logger.error("Error creating user", error);
    return res.status(500).json({ message: "Error creating user" });
  }
}

export async function deleteUser(req: Request, res: Response) {
  const id = String(req.params.id);

  try {
    const result = await serializeAdminChange(async () => {
      const user = await User.findById(id, { admin: 1 }).lean();
      if (!user) return "not-found";
      if (user.admin && !(await hasOtherAdmin(id))) return "last-admin";
      await User.deleteOne({ _id: id });
      return "deleted";
    });
    if (result === "not-found") return res.status(404).json({ message: "User not found" });
    if (result === "last-admin") return res.status(409).json({ message: LAST_ADMIN });
    await PushSubscription.deleteMany({ user: id });

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
    // Hash outside the serialized section, it takes a while
    const password = data.password ? await hashPassword(data.password) : undefined;
    const result = await serializeAdminChange(async () => {
      const user = await User.findById(id);
      if (!user) return "not-found";
      if (data.admin === false && user.admin && !(await hasOtherAdmin(id))) return "last-admin";

      if (data.name) user.name = data.name;
      if (data.email) user.email = data.email;
      if (data.admin !== undefined) user.admin = data.admin;
      if (password) {
        user.password = password;
        user.requiresPasswordChange = true;
        // Sign out the user's sessions; an admin resetting their own password keeps the current session
        const issuedAt = res.locals.tokenIssuedAt;
        const self = req.user?._id.toString() === id && typeof issuedAt === "number";
        user.passwordChangedAt = self ? new Date(issuedAt * 1000) : passwordChangeTime();
      }

      await user.save();
      return user;
    });
    if (result === "not-found") return res.status(404).json({ message: "User not found" });
    if (result === "last-admin") return res.status(409).json({ message: LAST_ADMIN });

    return res.status(200).json(result);
  } catch (error) {
    if (isDuplicateKeyError(error)) return res.status(400).json({ message: EMAIL_IN_USE });
    logger.error("Error updating user", error);
    return res.status(500).json({ message: "Error updating user" });
  }
}
