import mongoose from "mongoose";

// Learned parameters per area (fox team). Defaults are the spec's start values.
const PredictionModelSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, unique: true, lowercase: true },
    speedFactor: { type: Number, default: 1 },
    dwellMinutes: { type: Number, default: 15 },
    weights: {
      wTime: { type: Number, default: 1 },
      wHeading: { type: Number, default: 0.5 },
      wTour: { type: Number, default: 0.7 },
      wCluster: { type: Number, default: 0.3 },
    },
    accuracy: {
      top1Hits: { type: Number, default: 0 },
      top3Hits: { type: Number, default: 0 },
      evaluations: { type: Number, default: 0 },
    },
    lastHintTime: { type: Date, default: null },
    lastDwellVisitAt: { type: Date, default: null },
    // { basedOn: Date, candidates: [{ teamApiId, probability, terms }] } waiting for the next visit
    pendingSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false },
);

export const PredictionModel = mongoose.model("PredictionModel", PredictionModelSchema);
