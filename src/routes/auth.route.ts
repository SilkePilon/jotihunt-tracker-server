import express from "express";
import * as tutorialController from "../auth/tutorial.controller";
import * as pairingController from "../controllers/pairing.controller";
import * as loginController from "../auth/login.controller";
import * as qrController from "../auth/qr.controller";
import { body } from "express-validator";
import verifyToken, { requireWebSession } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitFailures, limitRate } from "../middleware/rate-limit";

// Validators
const tutorialValidator = [
  body("version").isInt({ min: 0 }).withMessage("Versie moet een getal van 0 of hoger zijn.").toInt(),
];

const pairValidator = [
  body("code").isString().trim().isLength({ min: 4, max: 20 }).withMessage("Code is verplicht."),
  body("deviceName").optional().isString().trim().isLength({ max: 60 }).withMessage("Ongeldige apparaatnaam."),
];

// Guessing codes: at most 20 wrong codes per address per 15 minutes (a code is 32^8 and lives 5 minutes)
const pairLimiter = limitFailures({
  windowMs: 15 * 60 * 1000,
  maxFailures: 20,
  failureStatus: 400,
  resetOnSuccess: false,
  key: (req) => String(req.ip),
});

// Brute force on verify: 30 failures per address per 15 minutes (each attempt needs a fresh challenge anyway)
const passkeyLimiter = limitFailures({
  windowMs: 15 * 60 * 1000,
  maxFailures: 30,
  failureStatus: 401,
  resetOnSuccess: false,
  key: (req) => String(req.ip),
});
const optionsLimiter = limitRate({ windowMs: 15 * 60 * 1000, max: 200, key: (req) => String(req.ip) });
// Starting codes: 60 per address per 15 minutes (one login page makes a new code every 2 minutes, so this
// leaves room for several laptops behind one NAT)
const qrStartLimiter = limitRate({ windowMs: 15 * 60 * 1000, max: 60, key: (req) => String(req.ip) });
// Polling is every 1.5 s (600 per 15 minutes per open login page); 6000 allows ten HQ laptops behind one NAT.
// Polls are cheap reads behind a 256-bit secret
const qrPollLimiter = limitRate({ windowMs: 15 * 60 * 1000, max: 6000, key: (req) => String(req.ip) });
// Guessing codes from a logged-in phone: 30 unknown codes per address per 15 minutes
const qrScanLimiter = limitFailures({
  windowMs: 15 * 60 * 1000,
  maxFailures: 30,
  failureStatus: 404,
  resetOnSuccess: false,
  key: (req) => String(req.ip),
});

const router = express.Router();

// Web: passkey login, the logged-in user and logout
router.post("/passkey/login/options", optionsLimiter, loginController.loginOptions);
router.post(
  "/passkey/login/verify",
  passkeyLimiter,
  validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")]),
  loginController.loginVerify,
);
router.get("/me", verifyToken, loginController.me);
router.post("/logout", verifyToken, loginController.logout);

// QR login: the laptop shows a code and polls, a logged-in phone scans it and confirms with its passkey
router.post("/qr", qrStartLimiter, qrController.start);
router.get("/qr/:id", qrPollLimiter, qrController.poll);
router.post("/qr/scan/:code", [verifyToken, requireWebSession, qrScanLimiter], qrController.scan);
router.post(
  "/qr/scan/:code/approve",
  [verifyToken, requireWebSession, passkeyLimiter, validate([body("response").isObject().withMessage("response ontbreekt.")])],
  qrController.approve,
);
router.post("/qr/scan/:code/deny", [verifyToken, requireWebSession], qrController.deny);

router.post("/tutorial", [verifyToken, validate(tutorialValidator)], tutorialController.updateTutorial);

// Android app: pair with a one-time code (no session), refresh its device token and manage paired phones
router.post("/pair", pairLimiter, validate(pairValidator), pairingController.pair);
router.post("/refresh", verifyToken, pairingController.refresh);
router.get("/devices", verifyToken, pairingController.list);
// Before /devices/:id
router.delete("/devices/me", verifyToken, pairingController.removeCurrent);
router.delete("/devices/:id", verifyToken, pairingController.remove);

export default router;
