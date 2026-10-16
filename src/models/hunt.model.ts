import mongoose from "mongoose";

/** A hunt as listed on the logged-in /hunts page of jotihunt.nl (copied by the scraper cron). */
const HuntSchema = new mongoose.Schema({
  /** Upsert key: `code:<code>` when the hunt has a code, else `time:<area>:<iso time>` (see siteKeyOf). Missing on
   * hunts stored before 17 Oct 2026; the scraper backfills it from their code. */
  siteKey: {
    type: String,
    required: false,
  },
  area: {
    type: String,
    required: true,
  },
  /** Null for hunts without a code (confirmed with the fox's QR code since 16 Oct 2026). Not unique any more: the
   * old unique index is dropped by syncIndexes at startup. */
  huntCode: {
    type: String,
    required: false,
    default: null,
  },
  status: {
    type: String,
    required: true,
  },
  points: {
    type: Number,
    required: true,
  },
  huntTime: {
    type: Date,
    required: false,
  },
  updatedAt: {
    type: Date,
    required: true,
  },
});

// Upserted by this key; a duplicate would make the upsert update only one of them. Partial: old hunts without a key
// don't collide until they are backfilled
HuntSchema.index({ siteKey: 1 }, { unique: true, partialFilterExpression: { siteKey: { $type: "string" } } });

export const Hunt = mongoose.model("Hunt", HuntSchema);
