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
  /** articleTextHash of the content: its readable text and files, not its markup (what a summary is made from) */
  textHash: {
    type: String,
    required: false,
  },
  /** When textHash last changed (or the article was first stored); summaries and AI hint splits wait until the text is stable (TEXT_DEBOUNCE_MS) */
  textChangedAt: {
    type: Date,
    required: false,
  },
  /** Short Dutch summary made by Gemini (news and assignments only); empty until made */
  summary: {
    type: String,
    required: false,
  },
  /** `${textHash}:v3` of the text the summary was made from (summaryKey): a changed text, or one summarised by an older version, gets a new summary */
  summaryHash: {
    type: String,
    required: false,
  },
  /** `${textHash}:s3` of the text the AI hint split was made from (hintSplitKey; hint articles only): a changed text is split again */
  hintSplitHash: {
    type: String,
    required: false,
  },
});

export const Article = mongoose.model("Article", ArticleSchema);

/**
 * Ids >= 900000 belonged to seeded test hint articles (the seed scripts are gone, older databases may still hold
 * some); they stay excluded from the public list and from notifications.
 */
export function publicArticlesFilter() {
  return { id: { $lt: 900000 } };
}

/**
 * Version of the summaries: v2 summaries were made with the article's images (keyed on the raw HTML, contentHash);
 * v3 is keyed on textHash, so markup-only edits keep the summary. Current v2 summaries are re-keyed, not made again.
 */
export const SUMMARY_VERSION = "v3";

/** The summaryHash of a summary of this text made by the current version */
export const summaryKey = (textHash: string) => `${textHash}:${SUMMARY_VERSION}`;

/**
 * A changed text is summarised (or a hint split) only after it stayed the same this long (the organisation edits in
 * several saves)
 */
export const TEXT_DEBOUNCE_MS = 120_000;
export const SUMMARY_DEBOUNCE_MS = TEXT_DEBOUNCE_MS;

/**
 * Version of the AI hint splits: s2 is keyed on textHash, so markup-only edits keep the split. s3 marks areas the
 * article never names as none. Before, hintSplitHash
 * was the contentHash (raw HTML); a split of the current content is re-keyed, not made again.
 */
export const HINT_SPLIT_VERSION = "s3";

/** The hintSplitHash of a split of this text made by the current version */
export const hintSplitKey = (textHash: string) => `${textHash}:${HINT_SPLIT_VERSION}`;

/** The summaryHash a v2 summary of this raw content had (only to re-key those to v3) */
export const legacySummaryKey = (contentHash: string) => `${contentHash}:v2`;
