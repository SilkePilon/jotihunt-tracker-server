import mongoose, { type Connection, type Model } from "mongoose";

/**
 * The linked Life360 account (one document, key "life360") in the REAL database, like the Telegram link: it stays while
 * demo mode swaps the default connection. The access token is AES-256-GCM encrypted with LIFE360_SESSION_KEY; the
 * ciphertext is never logged or returned by the API. Members are never stored (memory only).
 */
export interface Life360LinkDoc {
  key: string;
  tokenCiphertext: string;
  iv: string;
  tag: string;
  /** The (dedicated) Life360 account's e-mail address */
  email: string;
  /** x-device-id used for the login (reused when logging in again) */
  deviceId: string;
  circleId: string;
  circleName: string;
  /** Name of the admin who linked it */
  linkedBy: string | null;
  linkedAt: Date;
}

export const LIFE360_LINK_KEY = "life360";

const Life360LinkSchema = new mongoose.Schema<Life360LinkDoc>(
  {
    key: { type: String, required: true, unique: true, default: LIFE360_LINK_KEY },
    tokenCiphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    email: { type: String, required: true },
    deviceId: { type: String, required: true },
    circleId: { type: String, required: true },
    circleName: { type: String, required: true },
    linkedBy: { type: String, default: null },
    linkedAt: { type: Date, required: true },
  },
  { collection: "life360links", versionKey: false },
);

/** The model on `connection` (the demo state store's connection to the real database; the test connection in tests). */
export function life360LinkModel(connection: Connection): Model<Life360LinkDoc> {
  return (connection.models.Life360Link as Model<Life360LinkDoc> | undefined) ?? connection.model<Life360LinkDoc>("Life360Link", Life360LinkSchema);
}
