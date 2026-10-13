import express from "express";
import * as authController from "../controllers/auth.controller";
import * as pairingController from "../controllers/pairing.controller";
import * as loginController from "../auth/login.controller";
import { body } from "express-validator";
import verifyToken from "../middleware/auth.middleware";
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

router.post("/tutorial", [verifyToken, validate(tutorialValidator)], authController.updateTutorial);

// Android app: pair with a one-time code (no session), refresh its device token and manage paired phones
router.post("/pair", pairLimiter, validate(pairValidator), pairingController.pair);
router.post("/refresh", verifyToken, pairingController.refresh);
router.get("/devices", verifyToken, pairingController.list);
// Before /devices/:id
router.delete("/devices/me", verifyToken, pairingController.removeCurrent);
router.delete("/devices/:id", verifyToken, pairingController.remove);

export default router;
