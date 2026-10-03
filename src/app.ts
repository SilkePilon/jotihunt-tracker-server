import express, { NextFunction, Request, Response } from "express";
import expressWinston from "express-winston";
import cors from "cors";
import { logger } from "./logger";
import { demoGate } from "./demo/database-switch";
import authRoute from "./routes/auth.route";
import trackerRoute from "./routes/tracker.route";
import markersRoute from "./routes/markers.route";
import teamsRoute from "./routes/teams.route";
import areasRoute from "./routes/areas.route";
import huntsRoute from "./routes/hunts.route";
import huntReportsRoute from "./routes/hunt-reports.route";
import articlesRoute from "./routes/articles.route";
import adminRoute from "./routes/admin.route";
import hintsRoute from "./routes/hints.route";
import predictionsRoute from "./routes/predictions.route";
import visitsRoute from "./routes/visits.route";
import notificationsRoute from "./routes/notifications.route";
import pushRoute from "./routes/push.route";
import demoRoute from "./routes/demo.route";
import settingsRoute from "./routes/settings.route";

export const app = express();
app.use(express.json());
// Express 5 leaves req.body undefined when no body parser matched; keep the Express 4 behaviour of an empty object
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
// Never write credentials (user JWTs, cookies) from request headers to the logs
app.use(expressWinston.logger({ winstonInstance: logger, headerBlacklist: ["authorization", "cookie"] }));
app.use(cors());

// The demo switch itself is not gated; every other request waits for a running switch (see database-switch.ts)
app.use("/demo", demoRoute);
app.use(demoGate);
app.use("/auth", authRoute);
app.use("/tracker", trackerRoute);
app.use("/markers", markersRoute);
app.use("/teams", teamsRoute);
app.use("/areas", areasRoute);
app.use("/hunts", huntsRoute);
app.use("/hunt-reports", huntReportsRoute);
app.use("/articles", articlesRoute);
app.use("/admin", adminRoute);
app.use("/hints", hintsRoute);
app.use("/predictions", predictionsRoute);
app.use("/visits", visitsRoute);
app.use("/notifications", notificationsRoute);
app.use("/push", pushRoute);
// After the demo gate: verifyToken reads the users of the default connection. The setting itself is global (real database).
app.use("/settings", settingsRoute);

// Fallback handlers (Express 5 forwards rejected promises from async handlers here)
app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  const { status = 500, message } = (err ?? {}) as { status?: number; message?: string };
  res.status(status).json({ message: status >= 500 ? "Internal server error" : message });
});
