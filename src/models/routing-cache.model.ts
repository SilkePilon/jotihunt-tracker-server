import mongoose from "mongoose";

const RoutingCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  /** The value came from the fallback router because ORS rejected this request (e.g. unroutable point) */
  estimate: { type: Boolean, default: false },
});

// MongoDB removes expired entries in the background; readCache also checks expiresAt
RoutingCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoutingCache = mongoose.model("RoutingCache", RoutingCacheSchema);
