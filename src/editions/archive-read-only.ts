import type { NextFunction, Request, Response } from "express";
import { isArchiveShown } from "./work-tracking";

/** Writes that don't touch game data (accounts, push, Beheer config, users, invites) also work in the archive. */
const ALLOWED_PREFIXES = ["/auth", "/account", "/herstel", "/invites", "/push", "/admin/config", "/admin/users", "/admin/invites"];

const isRead = (method: string) => method === "GET" || method === "HEAD" || method === "OPTIONS";

/** While an archive edition is shown, game data is read-only for everyone: 423. Mount after editionGate. */
export function archiveReadOnly(req: Request, res: Response, next: NextFunction) {
  if (!isArchiveShown() || isRead(req.method)) return next();
  const path = req.path;
  if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next();
  res.status(423).json({ message: "Archief is alleen-lezen" });
}
