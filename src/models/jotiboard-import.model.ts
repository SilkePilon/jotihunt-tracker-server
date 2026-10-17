import mongoose from "mongoose";

/**
 * What the Jotiboard sync did with one Jotiboard item × area (a pin or a hint solve): imported (with the marker / cell it
 * wrote) or skipped (with the reason). Items with a record are not processed again, except `no-cell` (the hint article may
 * still arrive). `deleted`: a hunter deleted the imported marker, so the pin stays away (also through a purge). Lives next to the markers in the default connection, so demo mode has its own.
 */
const JotiboardImportSchema = new mongoose.Schema({
  kind: { type: String, enum: ["pin", "hintSolve"], required: true },
  /** Pin id, or the hint's message id as text */
  externalId: { type: String, required: true },
  area: { type: String, required: true, lowercase: true },
  result: { type: String, enum: ["imported", "skipped"], required: true },
  reason: { type: String, enum: ["duplicate", "cell-solved", "no-cell", "deleted"] },
  /** Imported pin: the marker it created */
  markerId: { type: mongoose.Schema.Types.ObjectId, ref: "Marker" },
  /** Imported hint solve: the cell it solved and the answer it wrote (the purge only reopens the cell while it still holds it) */
  cellId: { type: mongoose.Schema.Types.ObjectId, ref: "HintCell" },
  answer: { type: String },
  createdAt: { type: Date, required: true, default: Date.now },
});

JotiboardImportSchema.index({ kind: 1, externalId: 1, area: 1 }, { unique: true });

export const JotiboardImport = mongoose.model("JotiboardImport", JotiboardImportSchema);
