import mongoose from "mongoose";

const RoutingCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});

// MongoDB removes expired entries in the background; readCache also checks expiresAt
RoutingCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RoutingCache = mongoose.model("RoutingCache", RoutingCacheSchema);
