import mongoose from "mongoose";
import { debug, logger } from "./logger";
import { app } from "./app";
import { scheduleCrons } from "./crons/schedule";
import { initPredictionSetting } from "./settings/prediction-setting";
import { getDemoStateStore, initDemoMode } from "./demo/database-switch";
import { installDemoWorld } from "./demo/demo-world";
import { huntOcr } from "./services/hunt-ocr.instance";
import { isTraccarConfigured, usesLegacyTraccarEnv } from "./services/traccar-http";

// A forgotten promise rejection is logged and the server keeps running; after an uncaught exception the process state
// is unknown, so log it and exit (docker restarts the server in a second or two)
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason instanceof Error ? reason : { reason: String(reason) });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception, exiting", error);
  // Give the file transports a moment to write the line
  setTimeout(() => process.exit(1), 500);
});

if (debug) logger.warn("Debug mode enabled");
logger.info("Starting Jotihunt tracker...");

// Check if JWT secret is set
if (!process.env.JWT_SECRET) {
  logger.error("JWT_SECRET is not set");
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.startsWith("change-me")) {
  logger.warn("JWT_SECRET is short or the example placeholder, set a long random value");
}

// Database connection
const db = process.env.MONGO_URI;
if (!db) {
  logger.error("MONGO_URI is not set");
  process.exit(1);
}
logger.info("Trying to connect to MongoDB...");
installDemoWorld((message) => logger.info(message));
// Connects to the real database, or to a freshly generated demo database when demo mode was left on
await initDemoMode(db, { logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message), error: (message, error) => logger.error(message, error) } }).then((state) => {
  logger.info(`Connected to MongoDB${state.enabled ? " (demo mode)" : ""}!`);
  if (debug) mongoose.set("debug", true);
});

// Global settings live in the real database (also in demo mode); cached in memory from here on
await initPredictionSetting(getDemoStateStore());

// Index maintenance of the real database runs in initDemoMode (and again whenever demo mode is switched off)

// Read hunt codes and times left unread by a restart
await huntOcr
  .resumePending()
  .then((count) => count > 0 && logger.info(`Resumed reading ${count} hunt report photo(s)`))
  .catch((error) => logger.error("Could not resume hunt report reading", error));
if (!process.env.GEMINI_API_KEY?.trim()) {
  logger.warn("GEMINI_API_KEY not set, hunt photos are not read and fox predictions are off");
}
if (!isTraccarConfigured) {
  logger.warn("TRACCAR_API_URL/TRACCAR_API_TOKEN not set, tracker endpoints will return 503");
} else if (usesLegacyTraccarEnv) {
  logger.warn("TRACCARR_API_URL/TRACCARR_API_TOKEN are deprecated, rename them to TRACCAR_API_URL/TRACCAR_API_TOKEN");
}
if (!process.env.TRACCAR_CLIENT_URL) {
  logger.warn("TRACCAR_CLIENT_URL not set, the tracker onboarding card shows a configuration warning");
}

// Start the server
const port = Number(process.env.PORT) || 3000;
logger.info(`Starting server on port ${port}...`);
app.listen(port, (error) => {
  if (error) {
    logger.error(`Failed to start server on port ${port}`, error);
    process.exit(1);
  }
  logger.info(`Server listening on port ${port}`);
});

logger.info("Starting cron jobs...");
scheduleCrons();
