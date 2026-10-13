import mongoose, { type Connection, type Model } from "mongoose";

/**
 * The linked Telegram account (one document, key "telegram") in the REAL database, like the settings: the link stays
 * while demo mode swaps the default connection. The mtcute session is AES-256-GCM encrypted with
 * TELEGRAM_SESSION_KEY; the ciphertext is never logged or returned by the API.
 */
export interface TelegramLinkDoc {
  key: string;
  sessionCiphertext: string;
  iv: string;
  tag: string;
  account: { id: number; name: string; username?: string | null; phoneMasked?: string | null };
  linkedAt: Date;
  /** Name of the admin who linked it */
  linkedBy?: string | null;
}

export const TELEGRAM_LINK_KEY = "telegram";

const TelegramLinkSchema = new mongoose.Schema<TelegramLinkDoc>(
  {
    key: { type: String, required: true, unique: true, default: TELEGRAM_LINK_KEY },
    sessionCiphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    account: {
      id: { type: Number, required: true },
      name: { type: String, required: true },
      username: { type: String, default: null },
      phoneMasked: { type: String, default: null },
    },
    linkedAt: { type: Date, required: true },
    linkedBy: { type: String, default: null },
  },
  { collection: "telegramlinks", versionKey: false },
);

/** The model on `connection` (the demo state store's connection to the real database; the test connection in tests). */
export function telegramLinkModel(connection: Connection): Model<TelegramLinkDoc> {
  return (connection.models.TelegramLink as Model<TelegramLinkDoc> | undefined) ?? connection.model<TelegramLinkDoc>("TelegramLink", TelegramLinkSchema);
}
