import mongoose from "mongoose";

// The latest prediction per area, so GET /predictions is a plain read.
const PredictionSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, default: "unknown" },
    mode: { type: String, enum: ["walking", "transit"], default: "walking" },
    estimate: { type: Boolean, default: false },
    transitUnavailable: { type: Boolean, default: false },
    lastObservation: { type: mongoose.Schema.Types.Mixed, default: null },
    zone: { type: mongoose.Schema.Types.Mixed, default: () => ({ core: null, outer: null, islands: [] }) },
    candidates: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    accuracy: { type: mongoose.Schema.Types.Mixed, default: () => ({ top1Hits: 0, top3Hits: 0, evaluations: 0 }) },
    updatedAt: { type: Date, required: true },
    paused: { type: Boolean, default: false },
    reason: { type: String },
    round: { type: Number, default: 1 },
    // All candidates with their terms (for learning); not exposed by the API
    snapshot: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    // Inputs fingerprint; unchanged + younger than 5 minutes = no recompute
    signature: { type: String, default: "" },
  },
  { minimize: false },
);

export const Prediction = mongoose.model("Prediction", PredictionSchema);
