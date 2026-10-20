import mongoose, { type Connection, type Model } from "mongoose";
import { BOT_MESSAGE_KINDS, type BotMessageKind } from "../services/telegram.helpers";

/**
 * A message from @Jotihunt_bot (only the bot's messages are stored), in the control database next to the Telegram link.
 * No TTL: a few hundred during the event at most.
 */
export interface TelegramMessageDoc {
  /** Telegram message id; unique, so a message is handled (and alerted) once */
  telegramId: number;
  text: string;
  kind: BotMessageKind;
  receivedAt: Date;
  /** Parsed details, e.g. `{ direction }` of a tegenhunt */
  data?: Record<string, unknown>;
  /** When its alerts were done; null: stored but not handled yet (retried at the next catch-up) */
  handledAt?: Date | null;
}

const TelegramMessageSchema = new mongoose.Schema<TelegramMessageDoc>(
  {
    telegramId: { type: Number, required: true, unique: true },
    text: { type: String, default: "" },
    kind: { type: String, enum: BOT_MESSAGE_KINDS, required: true },
    receivedAt: { type: Date, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    handledAt: { type: Date, default: null },
  },
  { collection: "telegrammessages", versionKey: false },
);

TelegramMessageSchema.index({ receivedAt: -1 });

export function telegramMessageModel(connection: Connection): Model<TelegramMessageDoc> {
  return (connection.models.TelegramMessage as Model<TelegramMessageDoc> | undefined) ?? connection.model<TelegramMessageDoc>("TelegramMessage", TelegramMessageSchema);
}
