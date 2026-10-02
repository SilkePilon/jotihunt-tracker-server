import mongoose from "mongoose";

/** What the notifier saw last (one document per database), so it only alerts about changes. */
const NotifierStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "notifier" },
  areaStatus: { type: Map, of: String, required: true, default: () => new Map() },
  lastArticleId: { type: Number, required: true, default: 0 },
  /** False until the first run stored the current state (that run sends nothing) */
  initialized: { type: Boolean, required: true, default: false },
});

export const NotifierState = mongoose.model("NotifierState", NotifierStateSchema);
