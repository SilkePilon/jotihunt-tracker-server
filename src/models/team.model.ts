import mongoose from "mongoose";
import { pointSchema } from "./point";

const TeamSchema = new mongoose.Schema({
  apiId: {
    type: Number,
    required: true,
    // Upserted by this key; a duplicate would make the upsert update only one of them
    unique: true,
  },
  name: {
    type: String,
    required: true,
  },
  accomodation: {
    type: String,
    required: true,
  },
  street: {
    type: String,
    required: true,
  },
  houseNumber: {
    type: Number,
    required: true,
  },
  housenumberAddition: {
    type: String,
    required: false,
  },
  postCode: {
    type: String,
    required: true,
  },
  city: {
    type: String,
    required: true,
  },
  area: {
    type: String,
    required: false,
  },
  location: {
    type: pointSchema,
    required: true,
  },
  /** Group logo from the public jotihunt.nl/subscriptions page (cdn.jotihunt.net), when the group uploaded one */
  logoUrl: {
    type: String,
    required: false,
  },
});

export const Team = mongoose.model("Team", TeamSchema);
