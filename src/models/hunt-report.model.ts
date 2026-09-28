import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { pointSchema } from "./point";
import { HUNT_AREAS, HUNT_KINDS } from "../services/hunt-report.helpers";

/** Last result of this code on jotihunt.nl, copied from the scraper (which only keeps the latest 15 hunts). */
const SiteResultSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    points: { type: Number, required: true },
    seenAt: { type: Date, required: true },
  },
  { _id: false },
);

const HuntReportSchema = new mongoose.Schema(
  {
    area: { type: String, enum: HUNT_AREAS, required: true },
    /** Normalised: whitespace removed, uppercase */
    huntCode: { type: String, required: true, unique: true },
    huntTime: { type: Date, required: true },
    kind: { type: String, enum: HUNT_KINDS, required: true },
    /** File name in UPLOADS_DIR */
    photo: { type: String, required: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedByName: { type: String, required: true },
    location: { type: pointSchema, required: false },
    /** The hunt marker created with this report (feeds the fox prediction) */
    markerId: { type: mongoose.Schema.Types.ObjectId, required: false },
    submittedAt: { type: Date, required: false },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    submittedByName: { type: String, required: false },
    site: { type: SiteResultSchema, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const HuntReport = mongoose.model("HuntReport", HuntReportSchema);
export type HuntReportDocument = HydratedDocument<InferSchemaType<typeof HuntReportSchema>>;
