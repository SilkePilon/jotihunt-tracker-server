import express from "express";
import { body } from "express-validator";
import * as accountController from "../auth/account.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();
router.post("/passkeys/options", verifyToken, accountController.addPasskeyOptions);
router.post(
  "/passkeys/verify",
  [verifyToken, validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")])],
  accountController.addPasskeyVerify,
);
export default router;
