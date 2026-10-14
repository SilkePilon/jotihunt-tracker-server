import express from "express";
import { body } from "express-validator";
import * as accountController from "../auth/account.controller";
import verifyToken, { requireWebSession } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();
const passkeyName = body("name").isString().trim().isLength({ min: 1, max: 40 }).withMessage("Naam moet 1 tot 40 tekens zijn.");

// Web sessions only: a paired phone's device token never manages passkeys
router.post("/passkeys/options", [verifyToken, requireWebSession], accountController.addPasskeyOptions);
router.post(
  "/passkeys/verify",
  [verifyToken, requireWebSession, validate([body("challengeId").isString().withMessage("challengeId ontbreekt."), body("response").isObject().withMessage("response ontbreekt.")])],
  accountController.addPasskeyVerify,
);
router.get("/", [verifyToken, requireWebSession], accountController.overview);
router.patch("/passkeys/:id", [verifyToken, requireWebSession, validate([passkeyName])], accountController.renamePasskey);
router.delete("/passkeys/:id", [verifyToken, requireWebSession], accountController.removePasskey);
router.delete("/sessions/:id", [verifyToken, requireWebSession], accountController.removeSession);
router.delete("/sessions", [verifyToken, requireWebSession], accountController.removeOtherSessions);
export default router;
