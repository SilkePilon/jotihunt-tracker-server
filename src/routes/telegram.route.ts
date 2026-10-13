import express from "express";
import { query } from "express-validator";
import * as telegramController from "../controllers/telegram.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

// The admin routes (linking) are in admin.route.ts under /admin/telegram
const router = express.Router();

router.get(
  "/messages",
  [verifyToken, validate([query("limit").optional().isInt({ min: 1, max: 200 }).withMessage("Limit moet 1 tot 200 zijn.").toInt()])],
  telegramController.listMessages,
);

export default router;
