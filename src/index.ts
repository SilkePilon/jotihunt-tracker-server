import mongoose from "mongoose";
import { dropRemovedNotificationTypes } from "./controllers/notifications.controller";
import { debug, logger } from "./logger";
import { flushSentry } from "./sentry";
import { app } from "./app";
import { scheduleCrons } from "./crons/schedule";
import { publicAppUrl, webauthnConfig } from "./auth/config";
import { setAuthConnection } from "./auth/auth-db";
import { ensurePasswordless } from "./auth/migrate";
import { initAppConfig, onAppConfigChange, setHuntTimesSource, settingsKeyOk } from "./settings/app-config";
import { aiAvailable } from "./services/ai/model";
import { getControlStore, getRegistry, initEditions, onEditionSwitch, updateEditionHuntTimes } from "./editions/database-switch";
import { initEditionSettings } from "./editions/edition-settings-store";
import { syncVehicleGroups } from "./services/tracker-onboarding.helpers";
import { vehicleGroups } from "./services/tracker-onboarding.instance";
import { isTraccarConfigured, usesLegacyTraccarEnv } from "./services/traccar-http";
import { isValidSessionKey } from "./services/session-crypto";
import { setTelegramService, telegramConfigFromSettings, TelegramService } from "./services/telegram.service";
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
import { OverpassClient } from "./services/fastfood.client";
import { FastfoodService, setFastfoodService } from "./services/fastfood.service";
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
// Connects the default connection to the shown Jotihunt edition (registers the existing data as 2026 on first boot)
// The services log through the app logger
const serviceLogger: ServiceLogger = { info: (message) => logger.info(message), warn: (message) => logger.warn(message), error: (message, error) => logger.error(message, error) };
await initEditions(db, { logger: serviceLogger }).then((registry) => {
  logger.info(`Connected to MongoDB, showing Jotihunt ${registry.shownYear}${registry.shownYear !== registry.liveYear ? " (archive)" : ""}`);
  if (debug) mongoose.set("debug", true);
});

// One-off (idempotent): HUNT_START_TIME/HUNT_END_TIME fill the live edition's missing hunt times, so the
// "not during the hunt" guard of the edition switch knows them too. Invalid values are skipped.
{
  const registry = getRegistry();
  const live = registry.editions.find((e) => e.year === registry.liveYear)!;
  const fromEnv = (value: string | undefined) => {
    const date = value?.trim() ? new Date(value.trim()) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  };
  const patch: { huntStart?: string; huntEnd?: string } = {};
  const envStart = fromEnv(process.env.HUNT_START_TIME);
  const envEnd = fromEnv(process.env.HUNT_END_TIME);
  if (live.huntStart === null && envStart) patch.huntStart = envStart;
  if (live.huntEnd === null && envEnd) patch.huntEnd = envEnd;
  if (Object.keys(patch).length > 0) {
    await updateEditionHuntTimes(live.year, patch);
    logger.info(`Jotihunt ${live.year}: hunt times taken from HUNT_START_TIME/HUNT_END_TIME`);
  }
}

// Per-edition settings live in the shown edition's database; re-read after every switch
await initEditionSettings();
onEditionSwitch(() => initEditionSettings());
// Hunt times belong to an edition (registry); env HUNT_START_TIME/HUNT_END_TIME back up the live one only
setHuntTimesSource({
  read: () => {
    const registry = getRegistry();
    const edition = registry.editions.find((e) => e.year === registry.shownYear)!;
    return { huntStart: edition.huntStart, huntEnd: edition.huntEnd, live: registry.shownYear === registry.liveYear };
  },
  write: async (patch) => {
    await updateEditionHuntTimes(getRegistry().shownYear, patch);
  },
});
// Settings moved from env to Beheer (env stays the fallback); secrets need SETTINGS_KEY
const { undecryptable } = await initAppConfig(getControlStore().connection);
// Names only, never values: these fall back to env until saved again with the current SETTINGS_KEY
for (const name of undecryptable) logger.warn(`Stored secret ${name} can't be decrypted with the current SETTINGS_KEY (missing or rotated): using the env value instead. Save it again in Beheer.`);
syncVehicleGroups(vehicleGroups);
if (!settingsKeyOk()) logger.warn("SETTINGS_KEY is missing or not 32 bytes (base64): keys and passwords can't be saved in Beheer. Generate one with: openssl rand -base64 32");
// Sessions, invites and herstel-links live in the control database, whichever edition is shown
setAuthConnection(getControlStore().connection);
// The passwordless migration runs at every start (idempotent), so the deploy order doesn't matter. Also on the shown
// edition's database when that is not the control database (its users were copied from the control database before this ran)
const controlConnection = getControlStore().connection;
for (const connection of mongoose.connection.name === controlConnection.name ? [controlConnection] : [controlConnection, mongoose.connection]) {
  await ensurePasswordless(connection)
    .then(({ cleaned, handles }) => logger.info(`Passwordless migration (${connection.name}): removed password data from ${cleaned} users, added WebAuthn handles to ${handles}`))
    .catch((error) => logger.error(`Passwordless migration of ${connection.name} failed`, error));
}

// Summaries (v3) and AI hint splits (s2) are keyed on the article's text (textHash): give older articles their textHash
// and re-key their still-current v2 summaries and raw-HTML hint splits, so none is made again (idempotent; game data,
// so also after an edition switch)
const migrateTextHashes = () =>
  migrateArticleTextHashes()
    .then(async ({ hashed, rekeyed }) => {
      const splits = await migrateHintSplitKeys();
      logger.info(`Article text hash migration (${mongoose.connection.name}): hashed ${hashed} articles, re-keyed ${rekeyed} summaries and ${splits} hint splits`);
    })
    .catch((error) => logger.error("Article text hash migration failed", error));
await migrateTextHashes();
onEditionSwitch(async () => {
  await migrateTextHashes();
});

// "hunt-deadline" was removed with manual hunt registration: drop it from stored notification preferences
await dropRemovedNotificationTypes()
  .then((count) => count > 0 && logger.info(`Removed old notification types from ${count} user(s)`))
  .catch((error) => logger.error("Could not remove old notification types", error));

// Telegram (tegenhunts and other @Jotihunt_bot messages). The link and the messages live in the control database like the
// settings; connecting runs in the background (retried with backoff) so a Telegram outage never delays the start
// Happy hours (from the bot's messages) are game data in the current database: their start/end timers are rebuilt
// from it now and after every edition switch
const happyHour = new HappyHourService({ logger: serviceLogger });
await happyHour.rebuild().catch((error) => logger.error("Could not schedule the happy hour alerts", error));
onEditionSwitch(() => happyHour.rebuild());
const telegramWarn = (message: string) => logger.warn(message);
const telegramConfig = telegramConfigFromSettings(process.env, telegramWarn);
if (!telegramConfig) logger.warn("No Telegram app credentials (Beheer → Koppelingen or TELEGRAM_API_ID/TELEGRAM_API_HASH): tegenhunts are not read from Telegram");
const telegram = new TelegramService({
  config: telegramConfig,
  sessionKeyOk: isValidSessionKey(process.env.TELEGRAM_SESSION_KEY?.trim() ?? ""),
  connection: getControlStore().connection,
  gateway: createMtcuteGateway,
  logger: serviceLogger,
  happyHour,
});
setTelegramService(telegram);
telegram.start().catch((error) => logger.error("Could not start the Telegram listener", error));
// New app credentials in Beheer: reconnect with them
let telegramKey = JSON.stringify(telegramConfig);
onAppConfigChange((part) => {
  if (part !== "secrets") return;
  const next = telegramConfigFromSettings(process.env, telegramWarn);
  if (JSON.stringify(next) === telegramKey) return;
  telegramKey = JSON.stringify(next);
  telegram.reconfigure(next).catch((error) => logger.error("Could not restart Telegram with the new app credentials", error));
});

// Life360: team members without our app share their location through a Life360 circle. The link lives in the control
// database like the Telegram link; polling runs in the background so Life360 never delays the start
const life360Config = life360ConfigFromEnv(process.env, (message) => logger.warn(message));
if (!process.env.LIFE360_SESSION_KEY?.trim()) logger.warn("LIFE360_SESSION_KEY not set, the Life360 layer is off");
const life360 = new Life360Service({ config: life360Config, connection: getControlStore().connection, client: new Life360Client(), logger: serviceLogger });
setLife360Service(life360);
life360.start().catch((error) => logger.error("Could not start the Life360 sync", error));
// Jotiboard: fox pins and hint solutions from jotiboard.nl are imported while an admin has sync on. The link lives in the
// control database like Life360's; the sync starts in the background
const jotiboardConfig = jotiboardConfigFromEnv(process.env, (message) => logger.warn(message));
if (!process.env.JOTIBOARD_SESSION_KEY?.trim()) logger.warn("JOTIBOARD_SESSION_KEY not set, the Jotiboard sync is off");
const jotiboard = new JotiboardService({ config: jotiboardConfig, connection: getControlStore().connection, client: new JotiboardClient(), logger: serviceLogger });
setJotiboardService(jotiboard);
jotiboard.start().catch((error) => logger.error("Could not start the Jotiboard sync", error));

// 3D buildings: z15 vector tiles from 3DBAG, cached in the control database on first view
const buildings = new BuildingsService({ connection: getControlStore().connection, client: new BagWfsClient(), logger: serviceLogger });
setBuildingsService(buildings);

// Fastfood layers: McDonald's, KFC and Burger King from OpenStreetMap, refreshed daily in the control database
const fastfood = new FastfoodService({ connection: getControlStore().connection, client: new OverpassClient(), logger: serviceLogger });
setFastfoodService(fastfood);
fastfood.start();

// Index maintenance of the shown edition's database runs in initEditions (and again after every edition switch)

if (!aiAvailable()) {
  logger.warn("No Gemini key (Beheer → AI or GEMINI_API_KEY): fox predictions are off, articles get no summary and hints are split by rule only");
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
