import mongoose from "mongoose";
import { debug, logger } from "./logger";
import { flushSentry } from "./sentry";
import { app } from "./app";
import { scheduleCrons } from "./crons/schedule";
import { publicAppUrl, webauthnConfig } from "./auth/config";
import { setAuthConnection } from "./auth/auth-db";
import { ensurePasswordless } from "./auth/migrate";
import { initPredictionSetting } from "./settings/prediction-setting";
import { initHuntableAreas } from "./settings/huntable-areas-setting";
import { initAppConfig, settingsKeyOk } from "./settings/app-config";
import { aiAvailable } from "./services/ai/model";
import { getDemoStateStore, initDemoMode, onDemoSwitch } from "./demo/database-switch";
import { installDemoWorld } from "./demo/demo-world";
import { huntOcr } from "./services/hunt-ocr.instance";
import { syncVehicleGroups } from "./services/tracker-onboarding.helpers";
import { vehicleGroups } from "./services/tracker-onboarding.instance";
import { isTraccarConfigured, usesLegacyTraccarEnv } from "./services/traccar-http";
import { setTelegramService, telegramConfigFromEnv, TelegramService } from "./services/telegram.service";
import { createMtcuteGateway } from "./services/telegram.gateway";
import { HappyHourService } from "./services/happy-hour.service";
import { JotiboardClient } from "./services/jotiboard.client";
import { jotiboardConfigFromEnv } from "./services/jotiboard.helpers";
import { JotiboardService, setJotiboardService } from "./services/jotiboard.service";
import { Life360Client } from "./services/life360.client";
import { life360ConfigFromEnv } from "./services/life360.helpers";
import { Life360Service, setLife360Service } from "./services/life360.service";
import { BagWfsClient } from "./services/buildings.client";
import { BuildingsService, setBuildingsService } from "./services/buildings.service";
import { migrateArticleTextHashes } from "./services/article-summary.service";
import { migrateHintSplitKeys } from "./services/hint-split.service";
import { errorText } from "./utils/error-text";
import type { ServiceLogger } from "./utils/service-logger";

// A forgotten promise rejection is logged and the server keeps running; after an uncaught exception the process state
// is unknown, so log it and exit (docker restarts the server in a second or two)
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason instanceof Error ? reason : { reason: String(reason) });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception, exiting", error);
  // Give the file transports a moment to write the line, and Sentry up to 2 s to send the error
  void Promise.all([flushSentry(2000), Bun.sleep(500)]).finally(() => process.exit(1));
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

// Passkeys need the relying party settings; links need the public URL
try {
  webauthnConfig();
  publicAppUrl();
} catch (error) {
  logger.error(errorText(error));
  process.exit(1);
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
// The services log through the app logger
const serviceLogger: ServiceLogger = { info: (message) => logger.info(message), warn: (message) => logger.warn(message), error: (message, error) => logger.error(message, error) };
await initDemoMode(db, { logger: serviceLogger }).then((state) => {
  logger.info(`Connected to MongoDB${state.enabled ? " (demo mode)" : ""}!`);
  if (debug) mongoose.set("debug", true);
});

// Global settings live in the real database (also in demo mode); cached in memory from here on
await initPredictionSetting(getDemoStateStore());
await initHuntableAreas(getDemoStateStore());
// Settings moved from env to Beheer (env stays the fallback); secrets need SETTINGS_KEY
await initAppConfig(getDemoStateStore().connection);
syncVehicleGroups(vehicleGroups);
if (!settingsKeyOk()) logger.warn("SETTINGS_KEY is missing or not 32 bytes (base64): keys and passwords can't be saved in Beheer. Generate one with: openssl rand -base64 32");
// Sessions, invites and herstel-links live in the real database, also while demo mode is on
setAuthConnection(getDemoStateStore().connection);
// The passwordless migration runs at every start (idempotent), so the deploy order doesn't matter. Also on the demo
// database when demo mode was on at boot (its users were copied from the real database before this ran)
const realConnection = getDemoStateStore().connection;
for (const connection of mongoose.connection.name === realConnection.name ? [realConnection] : [realConnection, mongoose.connection]) {
  await ensurePasswordless(connection)
    .then(({ cleaned, handles }) => logger.info(`Passwordless migration (${connection.name}): removed password data from ${cleaned} users, added WebAuthn handles to ${handles}`))
    .catch((error) => logger.error(`Passwordless migration of ${connection.name} failed`, error));
}

// Summaries (v3) and AI hint splits (s2) are keyed on the article's text (textHash): give older articles their textHash
// and re-key their still-current v2 summaries and raw-HTML hint splits, so none is made again (idempotent; game data,
// so also after a demo switch)
const migrateTextHashes = () =>
  migrateArticleTextHashes()
    .then(async ({ hashed, rekeyed }) => {
      const splits = await migrateHintSplitKeys();
      logger.info(`Article text hash migration (${mongoose.connection.name}): hashed ${hashed} articles, re-keyed ${rekeyed} summaries and ${splits} hint splits`);
    })
    .catch((error) => logger.error("Article text hash migration failed", error));
await migrateTextHashes();
onDemoSwitch(async () => {
  await migrateTextHashes();
});

// Telegram (tegenhunts and other @Jotihunt_bot messages). The link and the messages live in the real database like the
// settings; connecting runs in the background (retried with backoff) so a Telegram outage never delays the start
// Happy hours (from the bot's messages) are game data in the current database: their start/end timers are rebuilt
// from it now and after every demo switch
const happyHour = new HappyHourService({ logger: serviceLogger });
await happyHour.rebuild().catch((error) => logger.error("Could not schedule the happy hour alerts", error));
onDemoSwitch(() => happyHour.rebuild());
const telegramConfig = telegramConfigFromEnv(process.env, (message) => logger.warn(message));
if (!process.env.TELEGRAM_API_ID?.trim() || !process.env.TELEGRAM_API_HASH?.trim()) {
  logger.warn("TELEGRAM_API_ID/TELEGRAM_API_HASH not set, tegenhunts are not read from Telegram");
}
const telegram = new TelegramService({
  config: telegramConfig,
  connection: getDemoStateStore().connection,
  gateway: createMtcuteGateway,
  logger: serviceLogger,
  happyHour,
});
setTelegramService(telegram);
telegram.start().catch((error) => logger.error("Could not start the Telegram listener", error));

// Life360: team members without our app share their location through a Life360 circle. The link lives in the real
// database like the Telegram link; polling runs in the background so Life360 never delays the start
const life360Config = life360ConfigFromEnv(process.env, (message) => logger.warn(message));
if (!process.env.LIFE360_SESSION_KEY?.trim()) logger.warn("LIFE360_SESSION_KEY not set, the Life360 layer is off");
const life360 = new Life360Service({ config: life360Config, connection: getDemoStateStore().connection, client: new Life360Client(), logger: serviceLogger });
setLife360Service(life360);
life360.start().catch((error) => logger.error("Could not start the Life360 sync", error));
// Jotiboard: fox pins and hint solutions from jotiboard.nl are imported while an admin has sync on. The link lives in the
// real database like Life360's; the sync starts in the background
const jotiboardConfig = jotiboardConfigFromEnv(process.env, (message) => logger.warn(message));
if (!process.env.JOTIBOARD_SESSION_KEY?.trim()) logger.warn("JOTIBOARD_SESSION_KEY not set, the Jotiboard sync is off");
const jotiboard = new JotiboardService({ config: jotiboardConfig, connection: getDemoStateStore().connection, client: new JotiboardClient(), logger: serviceLogger });
setJotiboardService(jotiboard);
jotiboard.start().catch((error) => logger.error("Could not start the Jotiboard sync", error));

// 3D buildings: z15 vector tiles from 3DBAG, cached in the real database on first view
const buildings = new BuildingsService({ connection: getDemoStateStore().connection, client: new BagWfsClient(), logger: serviceLogger });
setBuildingsService(buildings);

// Index maintenance of the real database runs in initDemoMode (and again whenever demo mode is switched off)

// Read hunt codes and times left unread by a restart
await huntOcr
  .resumePending()
  .then((count) => count > 0 && logger.info(`Resumed reading ${count} hunt report photo(s)`))
  .catch((error) => logger.error("Could not resume hunt report reading", error));
if (!aiAvailable()) {
  logger.warn("No Gemini key (Beheer → AI or GEMINI_API_KEY): hunt photos are not read, fox predictions are off, articles get no summary and hints are split by rule only");
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
