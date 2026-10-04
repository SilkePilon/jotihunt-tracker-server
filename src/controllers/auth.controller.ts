import { Request, Response } from "express";
import { hashPassword, needsRehash, passwordChangeTime, setTutorialVersion, User } from "../models/user.model";
import jwt from "jsonwebtoken";
import { logger } from "../logger";

export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    // Validate request body
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    // Find the user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    // Check if the password matches
    const passwordMatch = await Bun.password.verify(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    // Replace an old, memory-hungry hash; only the password field, so this is not a password change
    if (needsRehash(user.password)) {
      await User.updateOne({ _id: user._id, password: user.password }, { $set: { password: await hashPassword(password) } });
    }

    const accessToken = signAccessToken(user);

    return res.status(200).json({
      accessToken,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        admin: user.admin,
        requiresPasswordChange: user.requiresPasswordChange,
        tutorialVersion: user.tutorialVersion,
      },
    });
  } catch (error) {
    logger.error("Error logging in", error);
    return res.status(500).json({ message: "Login failed" });
  }
}

/**
 * A new access token (with enough lifetime for the whole hunt). Its iat (whole seconds) is never before the user's
 * last password change, so a token issued in the same second as (or just after) a change is not rejected.
 */
function signAccessToken(user: { _id: unknown; passwordChangedAt?: Date | null }) {
  const now = Math.floor(Date.now() / 1000);
  const changedAt = user.passwordChangedAt ? Math.ceil(user.passwordChangedAt.getTime() / 1000) : 0;
  return jwt.sign({ _id: user._id, iat: Math.max(now, changedAt) }, process.env.JWT_SECRET!, {
    expiresIn: "36h",
  });
}

export async function updatePassword(req: Request, res: Response) {
  const { oldPassword, newPassword } = req.body;
  const user = req.user!;

  // check if old password is correct (400, not 401: a 401 means the session itself is gone)
  if (!(await Bun.password.verify(oldPassword, user.password))) {
    return res.status(400).json({
      message: "Old password is incorrect",
    });
  }

  user.password = await hashPassword(newPassword);
  user.requiresPasswordChange = false;
  // Sign out every session, including this one and ones newer than it: all tokens issued up to and including the
  // current second are no longer valid (one second later, so a token from earlier this second is rejected too). The
  // client switches to the returned token, which is issued at that second and so stays valid.
  user.passwordChangedAt = new Date(passwordChangeTime().getTime() + 1000);

  await user.save();
  return res.status(200).json({ message: "Password updated", accessToken: signAccessToken(user) });
}

export async function updateTutorial(req: Request, res: Response) {
  const tutorialVersion = await setTutorialVersion(req.user!, req.body.version);
  return res.status(200).json({ tutorialVersion });
}
