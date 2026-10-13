import jwt from "jsonwebtoken";
import type mongoose from "mongoose";
import { logger } from "../logger";
import { isObjectIdString } from "../utils/mongo";
import { sessions, type SessionDoc, type SessionVia } from "./models";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** lastUsedAt/expiresAt are written at most this often (every request would be a database write) */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** react-auth-kit needs an `exp`; the session document decides the real lifetime */
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export function signSessionToken(sessionId: string): string {
  return jwt.sign({ sid: sessionId, kind: "web" }, process.env.JWT_SECRET!, { expiresIn: TOKEN_TTL_SECONDS });
}

export async function createSession(userId: unknown, info: { label: string; via: SessionVia }, now = new Date()) {
  const session = await sessions().create({
    user: userId as mongoose.Types.ObjectId,
    label: info.label,
    via: info.via,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  const sessionId = String(session._id);
  return { token: signSessionToken(sessionId), sessionId };
}

/** The live session with this id (null when unknown or expired). Slides the expiry at most once per hour. */
export async function useSession(sessionId: string, now = new Date()): Promise<SessionDoc | null> {
  if (!isObjectIdString(sessionId)) return null;
  const session = await sessions().findById(sessionId).lean<SessionDoc>();
  if (!session || session.expiresAt.getTime() <= now.getTime()) return null;
  if (now.getTime() - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    sessions()
      .updateOne({ _id: session._id }, { $set: { lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } })
      .catch((error) => logger.warn(`Could not extend session: ${error}`));
  }
  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  if (!isObjectIdString(sessionId)) return;
  await sessions().deleteOne({ _id: sessionId });
}

export async function revokeUserSessions(userId: unknown): Promise<void> {
  await sessions().deleteMany({ user: userId as mongoose.Types.ObjectId });
}
