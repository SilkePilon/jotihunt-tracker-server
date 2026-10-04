import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { pointSchema } from "./point";
import { FIELD_SOURCES, HUNT_AREAS, OCR_STATUSES } from "../services/hunt-report.helpers";
import { invalidateOnWrite } from "../services/response-cache";

/** Last result of this code on jotihunt.nl, copied from the scraper (which only keeps the latest 15 hunts). */
const SiteResultSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    points: { type: Number, required: true },
    seenAt: { type: Date, required: true },
  },
  { _id: false },
);

/** Reading of the code and handwritten time from the photo (Gemini). Reports from before OCR have none: treated as done. */
const OcrSchema = new mongoose.Schema(
  {
    status: { type: String, enum: OCR_STATUSES, required: true },
    attempts: { type: Number, required: true, default: 0 },
    codeConfidence: { type: Number, required: false },
    timeConfidence: { type: Number, required: false },
    /** The time as read ("HH:MM") */
    rawTime: { type: String, required: false, default: null },
    /** Dutch, shown to HQ; never contains secrets */
    error: { type: String, required: false },
    readAt: { type: Date, required: false },
    /** Bounding box of the sticker in the photo: [ymin, xmin, ymax, xmax], 0..1000 (Gemini's format) */
    stickerBox: { type: [Number], required: false, default: undefined },
  },
  { _id: false },
);

const HuntReportSchema = new mongoose.Schema(
  {
    area: { type: String, enum: HUNT_AREAS, required: true },
    /** Normalised: whitespace removed; case-sensitive. null until read. Not unique: duplicates are flagged, not blocked. */
    huntCode: { type: String, required: false, default: null, index: true },
    /** Random id the phone generates per photo, so a retried upload (lost response) doesn't create a second hunt */
    uploadId: { type: String, required: false },
    /** null until read or entered; the upload time (createdAt) is used meanwhile */
    huntTime: { type: Date, required: false, default: null },
    /** Missing on reports from before OCR (entered by hand, so manual) */
    huntCodeSource: { type: String, enum: FIELD_SOURCES, required: false },
    huntTimeSource: { type: String, enum: FIELD_SOURCES, required: false },
    /** File name in UPLOADS_DIR */
    photo: { type: String, required: true },
    /** File name of the small list thumbnail the phone sent with the photo; missing on old and demo reports */
    thumb: { type: String, required: false },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedByName: { type: String, required: true },
    location: { type: pointSchema, required: false },
    /** The hunt marker created with this report (feeds the fox prediction) */
    markerId: { type: mongoose.Schema.Types.ObjectId, required: false },
    submittedAt: { type: Date, required: false },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    submittedByName: { type: String, required: false },
    /** When the "10 minutes left" notification was created (at most once per report) */
    deadlineWarnedAt: { type: Date, required: false, default: null },
    site: { type: SiteResultSchema, required: false },
    ocr: { type: OcrSchema, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Per user: the lookup of a retried upload filters on reportedBy too. Partial (not sparse): a sparse compound index
// still indexes documents without uploadId (reportedBy is always set), which would make those collide.
HuntReportSchema.index({ uploadId: 1, reportedBy: 1 }, { unique: true, partialFilterExpression: { uploadId: { $type: "string" } } });

// GET /hunt-reports is cached for a moment; every write clears it
invalidateOnWrite(HuntReportSchema, "huntReports");

export const HuntReport = mongoose.model("HuntReport", HuntReportSchema);
export type HuntReportDocument = HydratedDocument<InferSchemaType<typeof HuntReportSchema>>;
/** A report as a plain object (`.lean()`); a hydrated document fits too. */
export type HuntReportRecord = InferSchemaType<typeof HuntReportSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date };
