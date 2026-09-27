import express, { NextFunction, Request, Response } from "express";
import cron from "node-cron";
import trackerRoute from "./routes/tracker.route";
import markersRoute from "./routes/markers.route";
import teamsRoute from "./routes/teams.route";
import areasRoute from "./routes/areas.route";
import huntsRoute from "./routes/hunts.route";
import articlesRoute from "./routes/articles.route";
import adminRoute from "./routes/admin.route";
import retrieveJotihuntAreas from "./crons/jotihunt-areas.cron";
import retrieveJotihuntArticles from "./crons/jotihunt-articles.cron";
import scrapeJotihuntWebsite from "./crons/jotihunt-scraper.cron";
import winston from "winston";
import mongoose from "mongoose";
import expressWinston from "express-winston";
import cors from "cors";
import authRoute from "./routes/auth.route";

const debug = process.env.DEBUG === "true";

// Setup logging with Winston
export const logger = winston.createLogger({
  level: debug ? "debug" : "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.simple(),
        winston.format.printf((info) => `${info.timestamp} - ${info.level}: ${info.message}`),
      ),
    }),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});
if (debug) logger.warn("Debug mode enabled");

logger.info("Starting Jotihunt tracker...");

// Check if JWT secret is set
if (!process.env.JWT_SECRET) {
  logger.error("JWT_SECRET is not set");
  process.exit(1);
}

// Setup express and CORS
logger.info("Setting up Express and loading config...");
const app = express();
app.use(express.json());
// Express 5 leaves req.body undefined when no body parser matched; keep the Express 4 behaviour of an empty object
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
app.use(expressWinston.logger({ winstonInstance: logger }));
app.use(cors());

// Setup routes
logger.info("Setting up routes...");
app.use("/auth", authRoute);
app.use("/tracker", trackerRoute);
app.use("/markers", markersRoute);
app.use("/teams", teamsRoute);
app.use("/areas", areasRoute);
app.use("/hunts", huntsRoute);
app.use("/articles", articlesRoute);
app.use("/admin", adminRoute);

// Fallback handlers (Express 5 forwards rejected promises from async handlers here)
app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  const { status = 500, message } = (err ?? {}) as { status?: number; message?: string };
  res.status(status).json({ message: status >= 500 ? "Internal server error" : message });
});

// Database connection
const db = process.env.MONGO_URI;
if (!db) {
  logger.error("MONGO_URI is not set");
  process.exit(1);
}
logger.info("Trying to connect to MongoDB...");
await mongoose.connect(db).then(() => {
  logger.info("Connected to MongoDB!");
  if (debug) mongoose.set("debug", true);
});

// Surface index build failures (e.g. duplicate article ids blocking the unique index) instead of failing silently
await Promise.all(
  Object.values(mongoose.models).map((model) =>
    model.init().catch((error) => logger.error(`Could not build indexes for ${model.modelName}`, error)),
  ),
);

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

// Schedule cron jobs (only the ones whose configuration is present)
logger.info("Starting cron jobs...");
cron.setLogger(logger);

if (process.env.JOTIHUNT_API_URL) {
  cron.schedule("*/10 * * * * *", retrieveJotihuntAreas, { name: "jotihunt-areas", noOverlap: true });
  cron.schedule("*/10 * * * * *", retrieveJotihuntArticles, { name: "jotihunt-articles", noOverlap: true });
} else {
  logger.warn("JOTIHUNT_API_URL is not set, skipping areas and articles cron jobs");
}

if (process.env.JOTIHUNT_WEB_URL && process.env.JOTIHUNT_WEB_USERNAME && process.env.JOTIHUNT_WEB_PASSWORD) {
  cron.schedule("0 * * * * *", scrapeJotihuntWebsite, { name: "jotihunt-scraper", noOverlap: true });
} else {
  logger.warn("JOTIHUNT_WEB_URL/JOTIHUNT_WEB_USERNAME/JOTIHUNT_WEB_PASSWORD not set, skipping website scraper cron job");
}

if (!process.env.TRACCARR_API_URL || !process.env.TRACCARR_API_TOKEN) {
  logger.warn("TRACCARR_API_URL/TRACCARR_API_TOKEN not set, tracker endpoints will return 503");
}
