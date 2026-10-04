import mongoose from "mongoose";

const ArticleSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true,
    unique: true,
  },
  title: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
  },
  publishAt: {
    type: Date,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  messageType: {
    type: String,
    required: false,
  },
  maxPoints: {
    type: Number,
    required: false,
  },
  endTime: {
    type: Date,
    required: false,
  },
  contentHash: {
    type: String,
    required: false,
  },
  /** Short Dutch summary made by Gemini (news and assignments only); empty until made */
  summary: {
    type: String,
    required: false,
  },
  /** What the summary means for our team, as short points */
  summaryPoints: {
    type: [String],
    default: undefined,
  },
  /** contentHash the summary was made from: a changed article gets a new summary */
  summaryHash: {
    type: String,
    required: false,
  },
});

export const Article = mongoose.model("Article", ArticleSchema);

/**
 * Seeded test hint articles use ids >= 900000 (see src/scripts/seed-hint.ts); they are excluded from the public
 * list and from notifications.
 */
export function publicArticlesFilter() {
  return { id: { $lt: 900000 } };
}
