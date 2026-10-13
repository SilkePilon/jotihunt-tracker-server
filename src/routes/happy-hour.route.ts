import express from "express";
import verifyToken from "../middleware/auth.middleware";
import { currentHappyHour } from "../services/happy-hour.service";

const router = express.Router();

// The running or next happy hour (announced by @Jotihunt_bot, see happy-hour.service.ts); ended ones are "none"
router.get("/", verifyToken, async (_req, res) => {
  res.status(200).json(await currentHappyHour());
});

export default router;
