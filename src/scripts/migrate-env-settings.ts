import mongoose from "mongoose";
import { initAppConfig } from "../settings/app-config";
import { migrateEnvSettings } from "../settings/migrate-env";

const uri = process.env.MONGO_URI;
if (!uri) throw new Error("MONGO_URI is not set");
// The settings live in the real database (the demo database never holds them)
const connection = await mongoose.createConnection(uri).asPromise();
try {
  await initAppConfig(connection);
  const { copied, skippedSecrets } = await migrateEnvSettings("env-migration");
  console.log(copied.length ? `Copied from env into Beheer: ${copied.join(", ")}` : "Nothing to copy: no setting comes from env");
  if (skippedSecrets.length) console.log(`Skipped (SETTINGS_KEY missing): ${skippedSecrets.join(", ")}`);
  process.exitCode = 0;
} catch (error) {
  console.error("Error migrating env settings:", error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
