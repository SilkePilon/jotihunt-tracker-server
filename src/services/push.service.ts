import webpush from "web-push";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { deadline } from "./http-limits";
import { isTypeEnabled } from "./notifier.helpers";

export interface PushNotificationInput {
  _id: unknown;
  type: string;
  title: string;
  body?: string | null;
  urgent: boolean;
  data?: unknown;
}

export interface PushLogger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

/** The part of web-push used here; replaced in tests. */
export interface PushSender {
  sendNotification(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options?: webpush.RequestOptions): Promise<unknown>;
}

const PARALLEL_SENDS = 10;
/** Alerts older than this are useless (a fox status from an hour ago); the push service drops them. */
const PUSH_TTL_SECONDS = 15 * 60;
/** web-push's own timeout is a socket idle timeout; the deadline also ends a push service that trickles its answer */
const PUSH_TIMEOUT_MS = 10_000;
let pushDeadlineMs = 15_000;

let configured: boolean | null = null;
let sender: PushSender = webpush;

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

/** True when the VAPID keys are set (checked once, then cached; the scheduler checks first, with the app logger). */
export function isPushConfigured(log: Pick<PushLogger, "error"> = console): boolean {
  if (configured !== null) return configured;
  const publicKey = vapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return (configured = false);
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:jotihunt@example.com", publicKey, privateKey);
  } catch (error) {
    log.error("Invalid VAPID configuration, push notifications are off", { message: (error as Error)?.message });
    return (configured = false);
  }
  return (configured = true);
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "onbekend";
  }
}

/** Tests only */
export function setPushSender(next: PushSender | null) {
  sender = next ?? webpush;
}

/** Tests only */
export function setPushDeadline(ms: number) {
  pushDeadlineMs = ms;
}

/** Tests only */
export function resetPushConfig() {
  configured = null;
}

/** Push a notification to every subscribed device whose user has its type switched on. Never throws. */
export async function sendToAll(notification: PushNotificationInput, log: PushLogger = console): Promise<{ sent: number; removed: number }> {
  const result = { sent: 0, removed: 0 };
  if (!isPushConfigured(log)) return result;

  try {
    const subscriptions = await PushSubscription.find().lean();
    const userIds = [...new Set(subscriptions.map((subscription) => subscription.user.toString()))];
    const users = await User.find({ _id: { $in: userIds } }, { notificationPrefs: 1 }).lean();
    const disabledByUser = new Map(users.map((user) => [user._id.toString(), user.notificationPrefs?.disabledTypes ?? []]));
    const targets = subscriptions.filter((subscription) => {
      const disabled = disabledByUser.get(subscription.user.toString());
      return disabled !== undefined && isTypeEnabled(notification.type, disabled);
    });

    const payload = JSON.stringify({
      id: String(notification._id),
      type: notification.type,
      title: notification.title,
      body: notification.body ?? "",
      urgent: notification.urgent,
      url: "/",
    });
    const options: webpush.RequestOptions = { TTL: PUSH_TTL_SECONDS, urgency: notification.urgent ? "high" : "normal", timeout: PUSH_TIMEOUT_MS };

    for (let index = 0; index < targets.length; index += PARALLEL_SENDS) {
      await Promise.all(
        targets.slice(index, index + PARALLEL_SENDS).map(async (subscription) => {
          const keys = subscription.keys;
          if (!keys) return;
          try {
            await deadline(sender.sendNotification({ endpoint: subscription.endpoint, keys }, payload, options), pushDeadlineMs, "Push timed out");
            result.sent++;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await PushSubscription.deleteOne({ endpoint: subscription.endpoint });
              result.removed++;
            } else {
              // Never log the raw error: WebPushError carries the endpoint URL (a capability token), headers and body
              const { statusCode, message, body } = error as { statusCode?: number; message?: string; body?: unknown };
              log.error(`Push to ${endpointHost(subscription.endpoint)} failed`, { statusCode, message, body: String(body ?? "").slice(0, 200) });
            }
          }
        }),
      );
    }
  } catch (error) {
    // Mongo/other errors only: keep the message, not the object
    log.error("Sending push notifications failed", { message: (error as Error)?.message });
  }
  return result;
}
