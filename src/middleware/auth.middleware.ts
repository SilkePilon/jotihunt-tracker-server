import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";
import { logger } from "../logger";
import { useSession } from "../auth/sessions";
import { updateAccounts } from "../auth/user-store";
import { isObjectIdString } from "../utils/mongo";

/**
 * The per-request user without its read articles (grows with every opened article; only GET /articles/read reads
 * them, from its own query). Saves write only modified paths, so a save of req.user never touches readArticles.
 */
const WITHOUT_READ_STATE = { readArticles: 0 } as const;

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
    // Database errors reject: Express 5 passes them to the error handler
    const session = await useSession(decoded.sid);
    if (!session) return denied(res);
    const user = await User.findById(session.user, WITHOUT_READ_STATE);
    if (!user) return denied(res);
    req.user = user;
    res.locals.sessionId = decoded.sid;
    return next();
  }

  // Device tokens (paired phones) stay valid only while the device is still registered on the user
  if (!isObjectIdString(decoded._id) || typeof decoded.did !== "string") return denied(res);
  const user = await User.findById(decoded._id, WITHOUT_READ_STATE);
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
  // Also in the live edition's database while an archive is shown (the device list is the live one's)
  updateAccounts({ _id: userId, "devices.id": deviceId }, { $set: { "devices.$.lastSeenAt": now } }).catch((error) =>
    logger.warn(`Could not update device lastSeenAt: ${error}`),
  );
}

/** After verifyToken: only a web session (not a paired phone's device token) may manage the account's passkeys. */
export function requireWebSession(_req: Request, res: Response, next: NextFunction) {
  if (typeof res.locals.sessionId !== "string") return res.status(403).json({ message: "Alleen vanuit de website." });
  next();
}

export function isAdmin(req: Request, res: Response, next: NextFunction) {
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
