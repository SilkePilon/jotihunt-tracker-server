import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { User } from "../models/user.model";
import { createAccount } from "../auth/user-store";
import { createRecoveryLink } from "../auth/recovery";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { user: { type: "string" }, id: { type: "string" }, new: { type: "string" }, admin: { type: "boolean", default: false } },
});

const uri = process.env.MONGO_URI;
if (!uri || !process.env.PUBLIC_APP_URL) {
  console.error("MONGO_URI and PUBLIC_APP_URL must be set");
  process.exit(1);
}
if (!values.user && !values.id && !values.new) {
  console.error("Usage: bun run login-link -- --user <name> | --id <user id> | --new <name> [--admin]");
  process.exit(1);
}

await mongoose.connect(uri);
let user;
if (values.new) {
  user = await createAccount({ name: values.new, admin: values.admin });
  console.log(`Created ${values.admin ? "admin " : ""}user ${user.name} (${user._id})`);
} else if (values.id) {
  user = await User.findById(values.id);
} else {
  const matches = await User.find({ name: values.user });
  if (matches.length > 1) {
    console.error(`${matches.length} users are called ${values.user}; use --id with one of: ${matches.map((match) => String(match._id)).join(", ")}`);
    process.exit(1);
  }
  user = matches[0];
}
if (!user) {
  console.error("User not found");
  process.exit(1);
}
const { url, expiresAt } = await createRecoveryLink(user._id, null);
console.log(`Herstel-link for ${user.name} (valid until ${expiresAt.toLocaleTimeString("nl-NL")}, works once):\n${url}`);
await mongoose.disconnect();
