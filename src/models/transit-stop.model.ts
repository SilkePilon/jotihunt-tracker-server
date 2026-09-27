import mongoose from "mongoose";

const TransitStopSchema = new mongoose.Schema({
  osmId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ["train", "tram", "bus", "other"], required: true },
  // Plain GeoJSON point (no sub-document _id) so the 2dsphere index accepts it
  location: {
    type: { type: String, enum: ["Point"], required: true },
    coordinates: { type: [Number], required: true },
  },
});

TransitStopSchema.index({ location: "2dsphere" });

export const TransitStop = mongoose.model("TransitStop", TransitStopSchema);
