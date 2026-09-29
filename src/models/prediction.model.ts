import mongoose from "mongoose";

// The latest Gemini prediction per area, so GET /predictions is a plain read.
const PredictionSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, default: "unknown" },
    paused: { type: Boolean, default: false },
    reason: { type: String },
    updatedAt: { type: Date, required: true },
    round: { type: Number, default: 1 },
    /** Walk minutes were straight-line estimates */
    estimate: { type: Boolean, default: false },
    /** The last Gemini run failed; the fields below are from an older run */
    stale: { type: Boolean, default: false },
    error: { type: String },
    lastObservation: { type: mongoose.Schema.Types.Mixed, default: null },
    pin: { type: mongoose.Schema.Types.Mixed, default: null },
    confidence: { type: String, enum: ["low", "medium", "high"], default: null },
    candidates: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    visitedTeamApiIds: { type: [Number], default: () => [] },
    why: { type: String, default: "" },
    // Not exposed by the API: inputs fingerprint and the time of the last (possibly failed) attempt
    signature: { type: String, default: "" },
    attemptedAt: { type: Date },
  },
  { minimize: false },
);

export const Prediction = mongoose.model("Prediction", PredictionSchema);
