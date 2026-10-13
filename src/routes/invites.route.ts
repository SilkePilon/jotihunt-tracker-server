import express from "express";
import { body } from "express-validator";
import * as inviteController from "../auth/invite.controller";
import { validate } from "../middleware/validate.middleware";
import { limitFailures, limitRate } from "../middleware/rate-limit";

const nameRules = [body("name").isString().withMessage("Vul je naam in.").bail().trim().isLength({ min: 1, max: 40 }).withMessage("Je naam is 1 tot 40 tekens.")];

// Guessing codes: 30 unknown codes per address per 15 minutes
const lookupLimiter = limitFailures({ windowMs: 15 * 60 * 1000, maxFailures: 30, failureStatus: 404, resetOnSuccess: false, key: (req) => String(req.ip) });
const signupLimiter = limitRate({ windowMs: 15 * 60 * 1000, max: 60, key: (req) => String(req.ip) });

const router = express.Router();

router.get("/:code", lookupLimiter, inviteController.getInvite);
router.post("/:code/register/options", signupLimiter, validate(nameRules), inviteController.registerOptions);
router.post(
  "/:code/register/verify",
  signupLimiter,
  validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")]),
  inviteController.registerVerify,
);
router.post("/:code/register/no-passkey", signupLimiter, validate(nameRules), inviteController.registerWithoutPasskey);

export default router;
