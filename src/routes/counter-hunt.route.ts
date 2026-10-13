import express from "express";
import * as notificationsController from "../controllers/notifications.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

// The Tegenhunt card's state; tegenhunts themselves come in through Telegram (telegram.service.ts)
router.get("/", verifyToken, notificationsController.getCounterHunt);

export default router;
