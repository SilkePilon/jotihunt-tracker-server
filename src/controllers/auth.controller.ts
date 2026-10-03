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

    const accessToken = signAccessToken(user._id);

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

/** A new access token (with enough lifetime for the whole hunt) */
function signAccessToken(userId: unknown) {
  return jwt.sign({ _id: userId }, process.env.JWT_SECRET!, {
    expiresIn: "36h",
  });
}

export async function updatePassword(req: Request, res: Response) {
  const { oldPassword, newPassword } = req.body;
  const user = req.user!;

  // check if old password is correct
  if (!(await Bun.password.verify(oldPassword, user.password))) {
    return res.status(401).json({
      message: "Old password is incorrect",
    });
  }

  user.password = await hashPassword(newPassword);
  user.requiresPasswordChange = false;
  // Sign out every other session: tokens issued before this session's token are no longer valid. This session keeps
  // working, because the client keeps using its token after changing the password.
  const issuedAt = res.locals.tokenIssuedAt;
  user.passwordChangedAt = typeof issuedAt === "number" ? new Date(issuedAt * 1000) : passwordChangeTime();

  await user.save();
  return res.status(200).json({ message: "Password updated", accessToken: signAccessToken(user._id) });
}

export async function updateTutorial(req: Request, res: Response) {
  const tutorialVersion = await setTutorialVersion(req.user!, req.body.version);
  return res.status(200).json({ tutorialVersion });
}
