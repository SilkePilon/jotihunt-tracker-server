import mongoose from "mongoose";

export enum HintCellStatus {
  Open = "open",
  Solved = "solved",
  None = "none",
}

/** A team note with its author (assignments) */
export const NoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

/**
 * One hint article × one area. Older documents may still hold claimedBy/claimedAt/check/checkedBy/notes and status
 * "solving" from the old hints page: the board hides them and the next solve removes them.
 */
const HintCellSchema = new mongoose.Schema({
  articleId: { type: Number, required: true },
  area: { type: String, required: true, lowercase: true },
  publishAt: { type: Date, required: true },
  slotTime: { type: Date, required: true },
  snippet: { type: String },
  status: { type: String, enum: Object.values(HintCellStatus), default: HintCellStatus.Open, required: true },
  answer: { type: String },
  answerKind: { type: String, enum: ["rd", "text"] },
  answerLocation: { type: [Number], default: undefined }, // [lng, lat] for RD answers
  markerId: { type: mongoose.Schema.Types.ObjectId, ref: "Marker" },
  articleChanged: { type: Boolean, default: false, required: true },
});

HintCellSchema.index({ articleId: 1, area: 1 }, { unique: true });

export const HintCell = mongoose.model("HintCell", HintCellSchema);
