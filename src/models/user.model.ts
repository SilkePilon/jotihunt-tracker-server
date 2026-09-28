import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { VEHICLES } from "../services/tracker-onboarding.helpers";

/** The user's own Traccar device (created lazily by GET /tracker/me). */
const TrackerSchema = new mongoose.Schema(
  {
    deviceId: { type: Number, required: true },
    uniqueId: { type: String, required: true },
    vehicle: { type: String, enum: VEHICLES, required: true },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  admin: {
    type: Boolean,
    default: false,
    required: true,
  },
  requiresPasswordChange: {
    type: Boolean,
    default: true,
    required: true,
  },
  tracker: {
    type: TrackerSchema,
    required: false,
  },
});

// Exclude password from JSON response
UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.password;
    return ret;
  },
});

export const User = mongoose.model("User", UserSchema);
export type UserType = HydratedDocument<InferSchemaType<typeof UserSchema>>;
