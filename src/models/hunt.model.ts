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
  /** The time as the site shows it; a clock-only time keeps the date it was first stored with */
  huntTimeText: {
    type: String,
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

/**
 * Drop the unique `huntCode_1` index of databases from before siteKey (hunts without a code would collide on null).
 * Runs on its own before syncIndexes, so a failing sync can never leave it. Returns whether it was dropped.
 */
export async function dropLegacyHuntCodeIndex(): Promise<boolean> {
  const indexes = await Hunt.collection.indexes().catch((error: { codeName?: string }) => {
    // No collection yet: nothing to drop
    if (error.codeName === "NamespaceNotFound") return [];
    throw error;
  });
  if (!indexes.some((index) => index.name === "huntCode_1")) return false;
  await Hunt.collection.dropIndex("huntCode_1");
  return true;
}
