import express from "express";
import { param } from "express-validator";
import * as intelChatController from "../controllers/intel-chat.controller";
import verifyToken from "../middleware/auth.middleware";
import { limitRate } from "../middleware/rate-limit";
import { validate } from "../middleware/validate.middleware";

/** 30 questions per 10 minutes per user (each one is several Gemini calls) */
export const INTEL_CHAT_LIMIT = { max: 30, windowMs: 10 * 60_000 };

const articleParam = validate([param("articleId").isInt({ min: 0 })]);
const limitQuestions = limitRate({ ...INTEL_CHAT_LIMIT, key: (req) => req.user?._id.toString() ?? req.ip ?? "", body: { error: "rate_limited" } });

const router = express.Router();

router.get("/:articleId", [verifyToken, articleParam], intelChatController.getChat);
router.post("/:articleId", [verifyToken, limitQuestions, articleParam], intelChatController.postChat);
router.delete("/:articleId", [verifyToken, articleParam], intelChatController.deleteChat);

export default router;
