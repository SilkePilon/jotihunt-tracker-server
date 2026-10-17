import mongoose from "mongoose";

const PartsSchema = new mongoose.Schema(
  {
    hunts: { type: Number, default: null },
    counterHunts: { type: Number, default: null },
    assignments: { type: Number, default: null },
    photoAssignments: { type: Number, default: null },
    /** null while jotihunt.nl shows "?" */
    hints: { type: Number, default: null },
    /** Points subtracted, as the positive number the site shows */
    penalty: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * Our provisional score as the jotihunt.nl dashboard shows it (one document per database), read every 2 minutes by the
 * score cron. Game data, so in the current database like the hunts.
 */
const SiteScoreSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "score" },
  /** The site's total, never recomputed from the parts; null before the first read */
  total: { type: Number, default: null },
  parts: { type: PartsSchema, default: () => ({}) },
  /** The total before the last change (null until it changed once) */
  previousTotal: { type: Number, default: null },
  /** When the total last changed; not set by the first read */
  changedAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  /** Short Dutch text of the last failed read; cleared by every successful read */
  lastError: { type: String, default: null },
});

export const SiteScore = mongoose.model("SiteScore", SiteScoreSchema);
