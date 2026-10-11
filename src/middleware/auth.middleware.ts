import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { logger } from "../logger";

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function denied(res: Response) {
  return res.status(401).json({
    message: "Access denied",
  });
}

/** Answer for a user who must change their (admin-set) password first; clients show the password change screen. */
export const PASSWORD_CHANGE_REQUIRED = { message: "Wijzig eerst je wachtwoord.", code: "PASSWORD_CHANGE_REQUIRED" };

/**
 * Authenticate the request by its Bearer JWT. Only a missing/invalid/expired token, an unknown user or a token issued
 * before the last password change get a 401 (clients sign out on 401). Database errors go to the error handler
 * (503), so a database hiccup never logs every hunter out. A user who must still change their password gets a 403
 * PASSWORD_CHANGE_REQUIRED (not signed out).
 */
export default function verifyToken(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, false);
}

/** verifyToken for what the password change screen needs (changing the password, logging out): no forced change. */
export function verifyTokenAllowingPasswordChange(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, true);
}

/** lastSeenAt of a device is written at most this often (every request would be a database write). */
const DEVICE_SEEN_INTERVAL_MS = 60 * 60 * 1000;

/** Fire-and-forget: a failed or late write (e.g. the user is gone) only logs a warning, never rejects. */
function touchDevice(userId: unknown, deviceId: string, lastSeenAt: Date | null | undefined) {
  const now = new Date();
  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < DEVICE_SEEN_INTERVAL_MS) return;
  User.updateOne({ _id: userId, "devices.id": deviceId }, { $set: { "devices.$.lastSeenAt": now } }).catch((error) =>
    logger.warn(`Could not update device lastSeenAt: ${error}`),
  );
}

async function authenticate(req: Request, res: Response, next: NextFunction, allowPasswordChange: boolean) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return denied(res);

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    return denied(res);
  }
  if (typeof decoded !== "object" || typeof decoded._id !== "string" || !OBJECT_ID.test(decoded._id)) return denied(res);

  let user;
  try {
    user = await User.findById(decoded._id);
  } catch (error) {
    return next(error);
  }

  if (!user) {
    logger.warn(`User not found with ID ${decoded._id}`);
    return denied(res);
  }
  if (!isIssuedAfterPasswordChange(decoded.iat, user.passwordChangedAt)) return denied(res);
  // Device tokens (paired phones) stay valid only while the device is still registered on the user
  if (decoded.did !== undefined) {
    if (typeof decoded.did !== "string") return denied(res);
    const device = user.devices?.find((entry) => entry.id === decoded.did);
    if (!device) return denied(res);
    touchDevice(user._id, device.id, device.lastSeenAt);
    res.locals.deviceId = device.id;
  }
  if (user.requiresPasswordChange && !allowPasswordChange) return res.status(403).json(PASSWORD_CHANGE_REQUIRED);

  req.user = user;
  // Issue time of this session's token, for keeping it valid when the user changes their own password
  res.locals.tokenIssuedAt = decoded.iat;

  next();
}

/** A token issued (seconds) before the last password change is no longer valid. Users without the field: always valid. */
export function isIssuedAfterPasswordChange(issuedAt: number | undefined, passwordChangedAt: Date | null | undefined): boolean {
  if (!passwordChangedAt) return true;
  if (typeof issuedAt !== "number") return false;
  return issuedAt * 1000 >= passwordChangedAt.getTime();
}

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      message: "Access denied",
    });
  }

  if (!req.user.admin) {
    return res.status(403).json({
      message: "Access denied",
    });
  }

  next();
}

interface JwtPayload {
  _id: string;
  iat?: number;
  /** Device id of a paired phone (device tokens only) */
  did?: string;
}
