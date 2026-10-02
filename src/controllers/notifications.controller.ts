import { Request, Response } from "express";
import { AppNotification, toNotificationView } from "../models/notification.model";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { buildBroadcastNotification } from "../services/notifier.helpers";
import { sendToAll, vapidPublicKey } from "../services/push.service";

const FEED_LIMIT = 50;

/** New notifications after `since`; without `since` only the server time, so a client starts at "now". */
export async function listNotifications(req: Request, res: Response) {
  const serverTime = new Date();
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : null;
  if (!since || Number.isNaN(since.getTime())) return res.status(200).json({ notifications: [], serverTime });
  const notifications = await AppNotification.find({ createdAt: { $gt: since, $lte: serverTime } })
    .sort({ createdAt: 1 })
    .limit(FEED_LIMIT)
    .lean();
  return res.status(200).json({ notifications: notifications.map(toNotificationView), serverTime });
}

function prefsOf(user: { notificationPrefs?: { disabledTypes?: string[]; promptedVersion?: number } | null }) {
  return { disabledTypes: [...(user.notificationPrefs?.disabledTypes ?? [])], promptedVersion: user.notificationPrefs?.promptedVersion ?? 0 };
}

export async function getPreferences(req: Request, res: Response) {
  return res.status(200).json(prefsOf(req.user!));
}

export async function putPreferences(req: Request, res: Response) {
  const update: Record<string, unknown> = {};
  if (Array.isArray(req.body.disabledTypes)) update.$set = { "notificationPrefs.disabledTypes": [...new Set(req.body.disabledTypes as string[])] };
  if (req.body.promptedVersion !== undefined) update.$max = { "notificationPrefs.promptedVersion": Number(req.body.promptedVersion) };
  const user = await User.findByIdAndUpdate(req.user!._id, update, { returnDocument: "after" }).lean();
  return res.status(200).json(prefsOf(user ?? req.user!));
}

export function getVapidKey(_req: Request, res: Response) {
  const publicKey = vapidPublicKey();
  if (!publicKey) return res.status(404).json({ message: "Pushmeldingen zijn niet ingesteld op de server." });
  return res.status(200).json({ publicKey });
}

/** Upsert by endpoint: a device that logs in as another user moves to that user. */
export async function subscribe(req: Request, res: Response) {
  const { endpoint, keys } = req.body;
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: req.user!._id, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: req.get?.("user-agent") },
    { upsert: true },
  );
  return res.status(204).end();
}

export async function unsubscribe(req: Request, res: Response) {
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user!._id });
  return res.status(204).end();
}

export async function broadcast(req: Request, res: Response) {
  const notification = await AppNotification.create(buildBroadcastNotification(String(req.body.message).trim(), req.user!.name));
  void sendToAll(notification);
  return res.status(201).json(toNotificationView(notification));
}
