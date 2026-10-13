import express from "express";
import { body } from "express-validator";
import * as settingsController from "../settings/settings.controller";
import * as adminAuthController from "../auth/admin-auth.controller";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

router.get("/prediction", verifyToken, settingsController.getPredictionSetting);
router.put("/prediction", [verifyToken, isAdmin, validate([body("enabled").isBoolean({ strict: true }).withMessage("Enabled moet true of false zijn.")])], settingsController.putPredictionSetting);
router.get("/invites-paused", verifyToken, adminAuthController.getInvitesPaused);
router.put(
  "/invites-paused",
  [verifyToken, isAdmin, validate([body("paused").isBoolean({ strict: true }).withMessage("Paused moet true of false zijn.")])],
  adminAuthController.putInvitesPaused,
);

export default router;
