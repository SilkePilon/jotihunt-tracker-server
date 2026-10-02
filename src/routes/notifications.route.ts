import express from "express";
import { body } from "express-validator";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { OPTIONAL_NOTIFICATION_TYPES } from "../services/notifier.helpers";

const preferencesValidator = [
  body("disabledTypes").optional().isArray().withMessage("disabledTypes moet een lijst zijn."),
  body("disabledTypes.*").isIn(OPTIONAL_NOTIFICATION_TYPES).withMessage("Onbekend meldingstype."),
  body("promptedVersion").optional().isInt({ min: 0 }).withMessage("Versie moet een getal van 0 of hoger zijn.").toInt(),
];

const router = express.Router();

router.get("/", verifyToken, notificationsController.listNotifications);
router.get("/preferences", verifyToken, notificationsController.getPreferences);
router.put("/preferences", [verifyToken, validate(preferencesValidator)], notificationsController.putPreferences);

export default router;
