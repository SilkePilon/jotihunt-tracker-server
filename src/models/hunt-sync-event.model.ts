import mongoose, { InferSchemaType } from "mongoose";
import { HUNT_SYNC_EVENT_TYPES } from "../services/hunt-sync-diff";
import { HuntLocationSchema } from "./hunt.model";

/** One line of the hunt sync log: a hunt came in, was approved or rejected, or its points changed */
const HuntSyncEventSchema = new mongoose.Schema({
  huntId: { type: mongoose.Schema.Types.ObjectId, ref: "Hunt", required: true },
  siteKey: { type: String, required: true },
  /** Lowercase fox team */
  area: { type: String, required: true },
  type: { type: String, enum: HUNT_SYNC_EVENT_TYPES, required: true },
  /** For approved / points events */
  points: { type: Number, required: false, default: null },
  /** When our sync noticed it */
  at: { type: Date, required: true },
  /** The hunt's time and location when the event was logged (the hunt may be gone later) */
  huntTime: { type: Date, required: false, default: null },
  location: {
    type: HuntLocationSchema,
    required: false,
    default: null,
  },
  /** Logged by the first import into an empty database: no push notifications */
  initial: { type: Boolean, required: true, default: false },
});

// Newest first, paged by `at`
HuntSyncEventSchema.index({ at: -1, _id: -1 });

export const HuntSyncEvent = mongoose.model("HuntSyncEvent", HuntSyncEventSchema);
export type HuntSyncEventDoc = InferSchemaType<typeof HuntSyncEventSchema> & { _id: mongoose.Types.ObjectId };
