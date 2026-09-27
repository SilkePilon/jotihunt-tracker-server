import mongoose from "mongoose";

export enum HintCellStatus {
  Open = "open",
  Solving = "solving",
  Solved = "solved",
  None = "none",
}

export enum HintCheck {
  Unchecked = "unchecked",
  Verified = "verified",
  Disputed = "disputed",
}

const NoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

const HintCellSchema = new mongoose.Schema({
  articleId: { type: Number, required: true },
  area: { type: String, required: true },
  publishAt: { type: Date, required: true },
  slotTime: { type: Date, required: true },
  snippet: { type: String },
  status: { type: String, enum: Object.values(HintCellStatus), default: HintCellStatus.Open, required: true },
  claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  claimedAt: { type: Date },
  answer: { type: String },
  answerKind: { type: String, enum: ["rd", "text"] },
  answerLocation: { type: [Number], default: undefined }, // [lng, lat] for RD answers
  markerId: { type: mongoose.Schema.Types.ObjectId, ref: "Marker" },
  check: { type: String, enum: Object.values(HintCheck), default: HintCheck.Unchecked, required: true },
  checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  notes: { type: [NoteSchema], default: [] },
  articleChanged: { type: Boolean, default: false, required: true },
});

HintCellSchema.index({ articleId: 1, area: 1 }, { unique: true });

export const HintCell = mongoose.model("HintCell", HintCellSchema);
