import mongoose from "mongoose";

export enum VisitState {
  Visited = "visited",
  NotVisited = "not_visited",
}

export enum VisitSource {
  Auto = "auto",
  Manual = "manual",
}

const GroupVisitSchema = new mongoose.Schema(
  {
    area: { type: String, required: true, lowercase: true },
    teamApiId: { type: Number, required: true },
    round: { type: Number, required: true, min: 1 },
    state: { type: String, enum: Object.values(VisitState), required: true },
    source: { type: String, enum: Object.values(VisitSource), required: true },
    visitedAt: { type: Date, default: null },
    evidence: { type: String },
  },
  { timestamps: true },
);

GroupVisitSchema.index({ teamApiId: 1, round: 1 }, { unique: true });
GroupVisitSchema.index({ area: 1, source: 1 });

export const GroupVisit = mongoose.model("GroupVisit", GroupVisitSchema);
