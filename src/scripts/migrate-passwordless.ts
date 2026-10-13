import mongoose from "mongoose";
import { migratePasswordless } from "../auth/migrate";
import { User } from "../models/user.model";

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set");
  process.exit(1);
}
await mongoose.connect(uri);
const result = await migratePasswordless(mongoose.connection);
// Creates the passkey index
await User.syncIndexes();
console.log(`Removed password data from ${result.cleaned} users, added WebAuthn handles to ${result.handles}.`);
await mongoose.disconnect();
