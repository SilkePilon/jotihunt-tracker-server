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
import invitesRoute from "./routes/invites.route";
import configRoute from "./routes/config.route";
import herstelRoute from "./routes/herstel.route";
import accountRoute from "./routes/account.route";
import trackerRoute from "./routes/tracker.route";
import markersRoute from "./routes/markers.route";
import teamsRoute from "./routes/teams.route";
import fastfoodRoute from "./routes/fastfood.route";
import areasRoute from "./routes/areas.route";
import huntsRoute from "./routes/hunts.route";
import scoreRoute from "./routes/score.route";
import articlesRoute from "./routes/articles.route";
import adminRoute from "./routes/admin.route";
import hintsRoute from "./routes/hints.route";
import assignmentsRoute from "./routes/assignments.route";
import predictionsRoute from "./routes/predictions.route";
import visitsRoute from "./routes/visits.route";
import notificationsRoute from "./routes/notifications.route";
import pushRoute from "./routes/push.route";
import demoRoute from "./routes/demo.route";
import appRoute from "./routes/app.route";
import settingsRoute from "./routes/settings.route";
import telegramRoute from "./routes/telegram.route";
import life360Route from "./routes/life360.route";
import buildingsRoute from "./routes/buildings.route";
import counterHuntRoute from "./routes/counter-hunt.route";
import happyHourRoute from "./routes/happy-hour.route";
import sentryTunnelRoute from "./routes/sentry-tunnel.route";
import intelChatRoute from "./routes/intel-chat.route";

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
// Building vector tiles too: compressible() doesn't know application/x-protobuf
// Never the AI chat's event stream: gzip would hold its chunks back
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type"));
      if (/event-stream/.test(type)) return false;
      return /x-protobuf/.test(type) || compression.filter(req, res);
    },
  }),
);
// Website error reports for Sentry (raw envelope body, no auth, before the JSON parser and the demo gate)
app.use("/sentry-tunnel", cors({ maxAge: 86400, exposedHeaders: ["X-Sentry-Rate-Limits", "Retry-After"] }), sentryTunnelRoute);
// AI chat questions may carry one image (≤ 2 MB, base64 in JSON); every other route keeps the 100 kB default
app.use("/intel-chat", express.json({ limit: "4mb" }));
app.use(express.json());
// Express 5 leaves req.body undefined when no body parser matched; keep the Express 4 behaviour of an empty object
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});
// Never write credentials (user JWTs, cookies, QR poll secrets) from request headers to the logs. Successful reads are not logged:
// every hunter polls a dozen endpoints every few seconds, which filled gigabytes of logs per event.
app.use(
  expressWinston.logger({
    winstonInstance: logger,
    headerBlacklist: ["authorization", "cookie", "x-qr-secret"],
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
app.use("/invites", invitesRoute);
app.use(configRoute);
app.use("/herstel", herstelRoute);
app.use("/account", accountRoute);
app.use("/tracker", trackerRoute);
app.use("/markers", markersRoute);
app.use("/teams", teamsRoute);
app.use("/fastfood", fastfoodRoute);
app.use("/areas", areasRoute);
app.use("/hunts", huntsRoute);
app.use("/score", scoreRoute);
// Manual hunt registration is gone (hunts come from the jotihunt.nl sync): old apps (Android 1.0.x) get a reason to update
app.use("/hunt-reports", (_req, res) => {
  res.status(410).json({ message: "Werk de app bij naar de nieuwste versie." });
});
app.use("/articles", articlesRoute);
app.use("/admin", adminRoute);
app.use("/hints", hintsRoute);
app.use("/assignments", assignmentsRoute);
app.use("/predictions", predictionsRoute);
app.use("/visits", visitsRoute);
app.use("/notifications", notificationsRoute);
app.use("/push", pushRoute);
// Messages of @Jotihunt_bot and the tegenhunt state; the Telegram link itself is in the real database
app.use("/telegram", telegramRoute);
// Members of the team's Life360 circle (memory only) and their avatars; the link itself is in the real database
app.use("/life360", life360Route);
// 3D building vector tiles (3DBAG), cached in the real database
app.use("/buildings", buildingsRoute);
app.use("/counter-hunt", counterHuntRoute);
app.use("/happy-hour", happyHourRoute);
// AI chat per user per Intel item (Gemini with our tools; the AI never writes)
app.use("/intel-chat", intelChatRoute);
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
