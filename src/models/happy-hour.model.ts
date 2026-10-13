import mongoose from "mongoose";

/**
 * A happy hour announced by @Jotihunt_bot (hunts count double). Game data, so in the current database like the
 * notifications. Overlapping announcements update one window; the *NotifiedAt fields make every alert fire once.
 */
const HappyHourSchema = new mongoose.Schema({
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  /** Text of the latest bot message about this window */
  text: { type: String, default: "" },
  /** Telegram ids of the messages merged into this window; unique, so a message is handled once */
  telegramIds: { type: [Number], required: true },
  /** False when no time was found in the message (the coming hour from receipt) */
  parsed: { type: Boolean, required: true, default: false },
  /** Set when handled, also when skipped (e.g. a window that had already ended when its message was read) */
  announcedAt: { type: Date, default: null },
  startNotifiedAt: { type: Date, default: null },
  endNotifiedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

HappyHourSchema.index({ telegramIds: 1 }, { unique: true });
HappyHourSchema.index({ endsAt: 1 });

export const HappyHour = mongoose.model("HappyHour", HappyHourSchema);
