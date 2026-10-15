import mongoose, { type Connection, type Model } from "mongoose";

/**
 * The linked Jotiboard account (one document, key "jotiboard") in the REAL database, like the Life360 link: it stays while
 * demo mode swaps the default connection. Only the Firebase refresh token is kept, AES-256-GCM encrypted with
 * JOTIBOARD_SESSION_KEY; the password is never stored. The ciphertext is never logged or returned by the API.
 */
export interface JotiboardLinkDoc {
  key: string;
  refreshCiphertext: string;
  iv: string;
  tag: string;
  username: string;
  /** Firebase uid of the account */
  uid: string;
  /** Name of the admin who linked it */
  linkedBy: string | null;
  linkedAt: Date;
  /** "Automatisch synchroniseren" */
  syncEnabled: boolean;
  /** reauth: Jotiboard refused the session, an admin has to log in again */
  state: "ok" | "reauth";
}

export const JOTIBOARD_LINK_KEY = "jotiboard";

const JotiboardLinkSchema = new mongoose.Schema<JotiboardLinkDoc>(
  {
    key: { type: String, required: true, unique: true, default: JOTIBOARD_LINK_KEY },
    refreshCiphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    username: { type: String, required: true },
    uid: { type: String, required: true },
    linkedBy: { type: String, default: null },
    linkedAt: { type: Date, required: true },
    syncEnabled: { type: Boolean, required: true, default: true },
    state: { type: String, enum: ["ok", "reauth"], required: true, default: "ok" },
  },
  { collection: "jotiboardlinks", versionKey: false },
);

/** The model on `connection` (the demo state store's connection to the real database; the test connection in tests). */
export function jotiboardLinkModel(connection: Connection): Model<JotiboardLinkDoc> {
  return (connection.models.JotiboardLink as Model<JotiboardLinkDoc> | undefined) ?? connection.model<JotiboardLinkDoc>("JotiboardLink", JotiboardLinkSchema);
}
