import express from "express";
import * as authController from "../controllers/auth.controller";
import * as pairingController from "../controllers/pairing.controller";
import { body } from "express-validator";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitFailures } from "../middleware/rate-limit";

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

const router = express.Router();

router.post("/tutorial", [verifyToken, validate(tutorialValidator)], authController.updateTutorial);

// Android app: pair with a one-time code (no session), refresh its device token and manage paired phones
router.post("/pair", pairLimiter, validate(pairValidator), pairingController.pair);
router.post("/refresh", verifyToken, pairingController.refresh);
router.get("/devices", verifyToken, pairingController.list);
// Before /devices/:id
router.delete("/devices/me", verifyToken, pairingController.removeCurrent);
router.delete("/devices/:id", verifyToken, pairingController.remove);

export default router;
