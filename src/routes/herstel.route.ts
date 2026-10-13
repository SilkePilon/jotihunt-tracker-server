import express from "express";
import { body } from "express-validator";
import * as recoveryController from "../auth/recovery.controller";
import { validate } from "../middleware/validate.middleware";
import { limitFailures, limitRate } from "../middleware/rate-limit";

const lookupLimiter = limitFailures({ windowMs: 15 * 60 * 1000, maxFailures: 30, failureStatus: 404, resetOnSuccess: false, key: (req) => String(req.ip) });
const useLimiter = limitRate({ windowMs: 15 * 60 * 1000, max: 60, key: (req) => String(req.ip) });

const router = express.Router();
router.get("/:token", lookupLimiter, recoveryController.getRecovery);
router.post("/:token/register/options", useLimiter, recoveryController.recoveryOptions);
router.post(
  "/:token/register/verify",
  useLimiter,
  validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")]),
  recoveryController.recoveryVerify,
);
router.post("/:token/no-passkey", useLimiter, recoveryController.recoveryWithoutPasskey);
export default router;
