import express, { Request, Response } from "express";
import expressWinston from "express-winston";
import cors from "cors";
import compression from "compression";
import { logger } from "./logger";
import { parseTrustProxy } from "./utils/trust-proxy";
import { clientIpHeader } from "./utils/client-ip-header";
import { demoGate } from "./demo/database-switch";
import { errorHandler } from "./middleware/error.middleware";
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
import assignmentsRoute from "./routes/assignments.route";
import presenceRoute from "./routes/presence.route";
import predictionsRoute from "./routes/predictions.route";
import visitsRoute from "./routes/visits.route";
import notificationsRoute from "./routes/notifications.route";
import pushRoute from "./routes/push.route";
import demoRoute from "./routes/demo.route";
import appRoute from "./routes/app.route";
import settingsRoute from "./routes/settings.route";

export const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
// Behind Cloudflare Tunnel + Traefik (k3s) the real client address is only in CF-Connecting-IP (see client-ip-header.ts)
if (process.env.CLIENT_IP_HEADER?.trim()) app.use(clientIpHeader(process.env.CLIENT_IP_HEADER));
app.disable("x-powered-by");
app.use((_req, res, next) => {
  // Browsers must never sniff a served file (e.g. an uploaded photo) into another type
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
// Polled JSON (hint board, hunt reports, predictions) shrinks 5-10x. ETags are computed on the uncompressed body
// before compression, so conditional requests still get a 304.
app.use(compression());
app.use(express.json());
// Express 5 leaves req.body undefined when no body parser matched; keep the Express 4 behaviour of an empty object
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
// Never write credentials (user JWTs, cookies) from request headers to the logs. Successful reads are not logged:
// every hunter polls a dozen endpoints every few seconds, which filled gigabytes of logs per event.
app.use(
  expressWinston.logger({
    winstonInstance: logger,
    headerBlacklist: ["authorization", "cookie"],
    // 4xx as warn, 5xx as error (so failing requests also land in error.log)
    statusLevels: true,
    skip: (req: Request, res: Response) => isQuietRequest(req.method, res.statusCode),
  }),
);
// Let browsers cache the CORS preflight for a day (it was ~45% of all requests)
app.use(cors({ maxAge: 86400 }));

// The demo switch itself is not gated; every other request waits for a running switch (see database-switch.ts)
app.use("/demo", demoRoute);
// Release files are not in the database, so this stays before the demo gate
app.use("/app", appRoute);
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
app.use("/assignments", assignmentsRoute);
app.use("/presence", presenceRoute);
app.use("/predictions", predictionsRoute);
app.use("/visits", visitsRoute);
app.use("/notifications", notificationsRoute);
app.use("/push", pushRoute);
// After the demo gate: verifyToken reads the users of the default connection. The setting itself is global (real database).
app.use("/settings", settingsRoute);

// Fallback handlers
app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});
app.use(errorHandler);

/** Successful reads and preflights are too frequent to log; errors and writes are always logged. */
export function isQuietRequest(method: string, statusCode: number): boolean {
  return statusCode < 400 && (method === "GET" || method === "HEAD" || method === "OPTIONS");
}
