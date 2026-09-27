import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";

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
