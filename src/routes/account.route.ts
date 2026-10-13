import express from "express";
import { body } from "express-validator";
import * as accountController from "../auth/account.controller";
import verifyToken, { requireWebSession } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();
// Web sessions only: a paired phone's device token never manages passkeys
router.post("/passkeys/options", [verifyToken, requireWebSession], accountController.addPasskeyOptions);
router.post(
  "/passkeys/verify",
  [verifyToken, requireWebSession, validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")])],
  accountController.addPasskeyVerify,
);
export default router;
