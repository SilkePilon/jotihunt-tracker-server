import mongoose from "mongoose";

/** One-time code shown as QR on the site; the app exchanges it for a device token. Only the hash is stored. */
const PairingCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, required: false, default: null },
});

// Mongo removes codes an hour after they expired (they can't be used after expiresAt anyway)
PairingCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

export const PairingCode = mongoose.model("PairingCode", PairingCodeSchema);
