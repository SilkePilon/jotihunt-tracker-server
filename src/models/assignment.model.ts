import mongoose from "mongoose";
import { NoteSchema } from "./hint-cell.model";

export enum AssignmentStatus {
  Open = "open",
  Busy = "busy",
  Submitted = "submitted",
  Skipped = "skipped",
}

/** What the assignment's page on jotihunt.nl showed when last checked (see jotihunt-assignment.parse) */
const SiteSubmissionSchema = new mongoose.Schema(
  {
    submitted: { type: Boolean, required: true, default: false },
    /** The handed-in photo */
    imageUrl: { type: String, default: null },
    /** Our own star rating of the assignment, 1–5 */
    rating: { type: Number, default: null },
    /** The judgement as the site shows it, e.g. "Nog niet beoordeeld" */
    judgement: { type: String, default: null },
    /** Judged: the page is not opened again */
    judged: { type: Boolean, required: true, default: false },
    /** Points read from the judgement; null when it has no number */
    points: { type: Number, default: null },
    checkedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * Our own bookkeeping for an assignment article ("opdracht"): who does it and how far it is. Created on the first
 * write; an assignment article without a document counts as open. Handing in happens on jotihunt.nl; the assignment
 * cron reads the page back into `site`.
 */
const AssignmentSchema = new mongoose.Schema(
  {
    articleId: { type: Number, required: true, unique: true },
    status: { type: String, enum: Object.values(AssignmentStatus), default: AssignmentStatus.Open, required: true },
    /** Who set the current status, and when; null: jotihunt.nl (the assignment cron saw it handed in) */
    statusBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    statusAt: { type: Date },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    /** Who assigned the current owner, and when */
    ownerBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    ownerAt: { type: Date },
    notes: { type: [NoteSchema], default: [] },
    /** The jotihunt.nl page as last checked (assignment cron); null until then */
    site: { type: SiteSubmissionSchema, default: null },
  },
  { timestamps: true },
);

export const Assignment = mongoose.model("Assignment", AssignmentSchema);
