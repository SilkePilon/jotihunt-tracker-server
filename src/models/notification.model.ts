import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { NOTIFICATION_TYPES } from "../services/notifier.helpers";

/** Something users are alerted about (push + in-app sound). Kept 48 hours; the feed only serves recent ones. */
const NotificationSchema = new mongoose.Schema({
  type: { type: String, enum: NOTIFICATION_TYPES, required: true },
  title: { type: String, required: true },
  body: { type: String, required: false, default: "" },
  data: { type: mongoose.Schema.Types.Mixed, required: false, default: {} },
  urgent: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });
// Latest of a type (broadcast history, current counter hunt)
NotificationSchema.index({ type: 1, createdAt: -1 });

// Named AppNotification: `Notification` is also the browser/Bun global
export const AppNotification = mongoose.model("Notification", NotificationSchema);
export type AppNotificationDocument = HydratedDocument<InferSchemaType<typeof NotificationSchema>>;

export function toNotificationView(notification: AppNotificationDocument | (InferSchemaType<typeof NotificationSchema> & { _id: unknown })) {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body ?? "",
    urgent: notification.urgent,
    data: notification.data ?? {},
    createdAt: notification.createdAt,
  };
}
export type NotificationView = ReturnType<typeof toNotificationView>;
