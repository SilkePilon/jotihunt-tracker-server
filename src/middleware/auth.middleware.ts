import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { logger } from "../logger";
import { useSession } from "../auth/sessions";
import { isObjectIdString } from "../utils/mongo";

function denied(res: Response) {
  return res.status(401).json({ message: "Access denied" });
}

/**
 * Authenticate the request by its Bearer JWT: a web session (`sid`) or a paired phone (`_id` + `did`). Only a
 * missing/invalid token, a gone session/device or an unknown user get a 401 (clients sign out on 401). Database
 * errors go to the error handler (503), so a database hiccup never logs every hunter out.
 */
export default async function verifyToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return denied(res);

  let decoded: TokenPayload;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
  } catch {
    return denied(res);
  }
  if (typeof decoded !== "object" || decoded === null) return denied(res);

  if (decoded.sid !== undefined) {
    if (!isObjectIdString(decoded.sid)) return denied(res);
    let session;
    try {
      session = await useSession(decoded.sid);
    } catch (error) {
      return next(error);
    }
    if (!session) return denied(res);
    let user;
    try {
      user = await User.findById(session.user);
    } catch (error) {
      return next(error);
    }
    if (!user) return denied(res);
    req.user = user;
    res.locals.sessionId = decoded.sid;
    return next();
  }

  // Device tokens (paired phones) stay valid only while the device is still registered on the user
  if (!isObjectIdString(decoded._id) || typeof decoded.did !== "string") return denied(res);
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
  const device = user.devices?.find((entry) => entry.id === decoded.did);
  if (!device) return denied(res);
  touchDevice(user._id, device.id, device.lastSeenAt);
  res.locals.deviceId = device.id;
  req.user = user;
  next();
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

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ message: "Access denied" });
  if (!req.user.admin) return res.status(403).json({ message: "Access denied" });
  next();
}

interface TokenPayload {
  /** Web session id */
  sid?: unknown;
  /** User id (device tokens) */
  _id?: unknown;
  /** Device id of a paired phone (device tokens only) */
  did?: unknown;
}
