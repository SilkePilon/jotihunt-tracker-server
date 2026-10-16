import mongoose, { InferSchemaType } from "mongoose";
import { invalidateOnWrite } from "../services/response-cache";

/** Where jotihunt.nl registered the hunt (the hunter's phone when scanning the fox's QR code) */
const HuntLocationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    /** Metres; null when the site shows none */
    accuracy: { type: Number, required: false, default: null },
  },
  { _id: false },
);

/**
 * A hunt as listed on the logged-in /hunts page of jotihunt.nl (copied by the scraper cron). Since 17 Oct 2026 this is
 * the only source of hunts: nobody registers them in the app.
 */
const HuntSchema = new mongoose.Schema({
  /** Upsert key (see siteKeyOf): `qr:<qr code>`, `code:<old hunt code>`, `id:<detail page id>` or
   * `time:<area>:<iso time>`. Missing on hunts stored before 17 Oct 2026; the scraper backfills it from their code. */
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
  /** The site's status text (kept under its old name for old clients); see statusText */
  status: {
    type: String,
    required: true,
  },
  /** pending / approved / rejected / unknown (classifyStatus); missing on hunts stored before 17 Oct 2026 */
  statusClass: {
    type: String,
    enum: ["pending", "approved", "rejected", "unknown"],
    required: false,
  },
  /** The site's status text ("Wacht op bevestiging") */
  statusText: {
    type: String,
    required: false,
  },
  qrCode: {
    type: String,
    required: false,
    default: null,
  },
  /** Never cleared by a scrape that found none (a detail page may not have been opened that run) */
  location: {
    type: HuntLocationSchema,
    required: false,
    default: null,
  },
  /** When our sync first saw it */
  firstSeenAt: {
    type: Date,
    required: false,
  },
  /** When its status class last changed (or it was first seen already judged) */
  statusChangedAt: {
    type: Date,
    required: false,
    default: null,
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

// GET /hunts is cached for a moment; every write clears it
invalidateOnWrite(HuntSchema, "hunts");

export const Hunt = mongoose.model("Hunt", HuntSchema);
export type HuntDoc = InferSchemaType<typeof HuntSchema> & { _id: mongoose.Types.ObjectId };

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
