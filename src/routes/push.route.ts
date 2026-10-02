import express from "express";
import { body } from "express-validator";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const subscribeValidator = [
  body("endpoint").isURL({ protocols: ["https"], require_tld: false }).withMessage("Ongeldig push-adres."),
  body("keys.p256dh").isString().notEmpty().withMessage("Sleutel ontbreekt."),
  body("keys.auth").isString().notEmpty().withMessage("Sleutel ontbreekt."),
];

const router = express.Router();

router.get("/vapid-key", notificationsController.getVapidKey);
router.post("/subscribe", [verifyToken, validate(subscribeValidator)], notificationsController.subscribe);
router.delete("/subscribe", [verifyToken, validate([body("endpoint").isString().notEmpty()])], notificationsController.unsubscribe);

export default router;
