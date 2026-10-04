import express from "express";
import { body } from "express-validator";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken, { verifyTokenAllowingPasswordChange } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const subscribeValidator = [
  body("endpoint").isURL({ protocols: ["https"], require_tld: false }).withMessage("Ongeldig push-adres."),
  body("keys.p256dh").isString().notEmpty().withMessage("Sleutel ontbreekt."),
  body("keys.auth").isString().notEmpty().withMessage("Sleutel ontbreekt."),
];

const router = express.Router();

router.get("/vapid-key", notificationsController.getVapidKey);
router.post("/subscribe", [verifyToken, validate(subscribeValidator)], notificationsController.subscribe);
// Logging out from the password change screen drops the push subscription too
router.delete("/subscribe", [verifyTokenAllowingPasswordChange, validate([body("endpoint").isString().notEmpty()])], notificationsController.unsubscribe);

export default router;
