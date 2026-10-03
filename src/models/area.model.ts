import mongoose from "mongoose";

const AreaSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    // Upserted by this key; a duplicate would make the upsert update only one of them
    unique: true,
  },
  status: {
    type: String,
    required: true,
  },
  updatedAt: {
    type: Date,
    required: true,
  },
});

export const Area = mongoose.model("Area", AreaSchema);
