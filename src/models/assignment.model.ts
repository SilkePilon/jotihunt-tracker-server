import mongoose from "mongoose";
import { NoteSchema } from "./hint-cell.model";

export enum AssignmentStatus {
  Open = "open",
  Busy = "busy",
  Submitted = "submitted",
  Skipped = "skipped",
}

/**
 * Our own bookkeeping for an assignment article ("opdracht"): who does it and how far it is. Created on the first
 * write; an assignment article without a document counts as open. Handing in happens on jotihunt.nl.
 */
const AssignmentSchema = new mongoose.Schema(
  {
    articleId: { type: Number, required: true, unique: true },
    status: { type: String, enum: Object.values(AssignmentStatus), default: AssignmentStatus.Open, required: true },
    /** Who set the current status, and when */
    statusBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    statusAt: { type: Date },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    /** Who assigned the current owner, and when */
    ownerBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    ownerAt: { type: Date },
    notes: { type: [NoteSchema], default: [] },
  },
  { timestamps: true },
);

export const Assignment = mongoose.model("Assignment", AssignmentSchema);
