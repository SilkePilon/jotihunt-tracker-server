import mongoose from "mongoose";

/** Cached route between two points for one profile (foot day / foot night+areas / car). Expires after 30 days. */
const RouteLegSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  coordinates: { type: [[Number]], required: true },
  distanceM: { type: Number, required: true },
  durationS: { type: Number, required: true },
  nightFallback: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
});
RouteLegSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RouteLeg = mongoose.model("RouteLeg", RouteLegSchema);
