import express from "express";
import * as authController from "../controllers/auth.controller";
import * as pairingController from "../controllers/pairing.controller";
import { body } from "express-validator";
import verifyToken, { verifyTokenAllowingPasswordChange } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitFailures } from "../middleware/rate-limit";
import { newPasswordRules } from "../utils/password-policy";

// Validators
const loginValidator = [
  body("email").isString().trim().notEmpty().withMessage("E-mailadres mag niet leeg zijn."),
  body("password").isString().notEmpty().withMessage("Wachtwoord mag niet leeg zijn."),
];

const updatePasswordValidator = [
  body("oldPassword").notEmpty().withMessage("Oude wachtwoord mag niet leeg zijn."),
  body("newPassword").notEmpty().withMessage("Nieuw wachtwoord mag niet leeg zijn."),
  newPasswordRules(body("newPassword")),
  body("confirmPassword").notEmpty().withMessage("Nieuw wachtwoord bevestiging mag niet leeg zijn."),
  body("newPassword")
    .custom((value, { req }) => value === req.body.confirmPassword)
    .withMessage("Wachtwoorden komen niet overeen"),
];

const tutorialValidator = [
  body("version").isInt({ min: 0 }).withMessage("Versie moet een getal van 0 of hoger zijn.").toInt(),
];

// Brute-force protection: 10 wrong passwords per address and e-mail per 15 minutes. Keyed on both, so a whole
// team logging in behind one NAT/proxy address is not locked out by one person mistyping.
const loginLimiter = limitFailures({
  windowMs: 15 * 60 * 1000,
  maxFailures: 10,
  failureStatus: 401,
  key: (req) => `${req.ip}|${String(req.body?.email ?? "").trim().toLowerCase()}`,
});
// Per address regardless of e-mail, so trying many different addresses is limited too. Not cleared by a success
// (one valid account must not reset it); 100 is far above the mistypes of a whole team behind one address.
const loginIpLimiter = limitFailures({
  windowMs: 15 * 60 * 1000,
  maxFailures: 100,
  failureStatus: 401,
  resetOnSuccess: false,
  key: (req) => String(req.ip),
});

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

const router = express.Router();

router.post("/login", loginIpLimiter, loginLimiter, validate(loginValidator), authController.login);
// The only route (besides logging out) a user who must change their password can use
router.post("/update-password", [verifyTokenAllowingPasswordChange, validate(updatePasswordValidator)], authController.updatePassword);
router.post("/tutorial", [verifyToken, validate(tutorialValidator)], authController.updateTutorial);

// Android app: pair with a one-time code (no session), refresh its device token and manage paired phones
router.post("/pair", pairLimiter, validate(pairValidator), pairingController.pair);
router.post("/refresh", verifyToken, pairingController.refresh);
router.get("/devices", verifyToken, pairingController.list);
// Before /devices/:id; also allowed while a password change is pending (unpairing must always work)
router.delete("/devices/me", verifyTokenAllowingPasswordChange, pairingController.removeCurrent);
router.delete("/devices/:id", verifyToken, pairingController.remove);

export default router;
