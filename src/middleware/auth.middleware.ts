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

/**
 * Authenticate the request by its Bearer JWT. Only a missing/invalid/expired token, an unknown user or a token issued
 * before the last password change get a 401 (clients sign out on 401). Database errors go to the error handler
 * (503), so a database hiccup never logs every hunter out.
 */
export default async function verifyToken(req: Request, res: Response, next: NextFunction) {
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
}
