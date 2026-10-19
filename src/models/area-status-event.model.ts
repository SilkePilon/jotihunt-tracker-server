import mongoose from "mongoose";

/** One area status change (from the Jotihunt API), to tell later which legs overlapped a red/orange period. */
const AreaStatusEventSchema = new mongoose.Schema({
  area: { type: String, required: true },
  status: { type: String, required: true },
  at: { type: Date, required: true },
});
AreaStatusEventSchema.index({ area: 1, at: 1 });

export const AreaStatusEvent = mongoose.model("AreaStatusEvent", AreaStatusEventSchema);
