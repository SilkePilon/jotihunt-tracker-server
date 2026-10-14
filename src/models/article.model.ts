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
  /** `${contentHash}:v2` of the content the summary was made from (summaryKey): a changed article, or one summarised by an older version, gets a new summary */
  summaryHash: {
    type: String,
    required: false,
  },
  /** contentHash the AI hint split was made from (hint articles only): a changed article is split again */
  hintSplitHash: {
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

/** Version of the summaries: v2 summaries were made with the article's images (older ones are made again once) */
export const SUMMARY_VERSION = "v2";

/** The summaryHash of a summary of this content made by the current version */
export const summaryKey = (contentHash: string) => `${contentHash}:${SUMMARY_VERSION}`;
