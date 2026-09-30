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
  /** Highest onboarding tour version this user has seen (client TOUR_VERSION); 0 = never. */
  tutorialVersion: {
    type: Number,
    default: 0,
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

/** Record that the user has seen the onboarding tour up to `version`. Never lowers the stored version. */
export async function setTutorialVersion(user: UserType, version: number): Promise<number> {
  // $max in the database, so concurrent requests can never lower the stored version
  const updated = await User.findOneAndUpdate({ _id: user._id }, { $max: { tutorialVersion: version } }, { returnDocument: "after" });
  user.tutorialVersion = updated?.tutorialVersion ?? Math.max(user.tutorialVersion ?? 0, version);
  return user.tutorialVersion;
}
