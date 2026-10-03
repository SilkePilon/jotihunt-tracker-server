import mongoose from "mongoose";
import { syncTeams } from "../services/team-sync.service";

await mongoose.connect(process.env.MONGO_URI!);
try {
  console.log("Retrieving Jotihunt teams from API...");
  const count = await syncTeams();
  console.log(`Synced ${count} teams`);
  process.exitCode = 0;
} catch (error) {
  console.error("Error loading teams:", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
