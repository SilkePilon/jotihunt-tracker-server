import mongoose from "mongoose";

/** A browser push endpoint of a user (one per device/browser). Removed when the push service reports it gone. */
const PushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const PushSubscription = mongoose.model("PushSubscription", PushSubscriptionSchema);
