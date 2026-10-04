import express from "express";
import { param } from "express-validator";
import * as articlesController from "../controllers/articles.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";

const router = express.Router();

router.get("/", verifyToken, articlesController.getArticles);
router.get("/read", verifyToken, articlesController.getRead);
router.post("/:id/read", [verifyToken, limitUserWrites(120), validate([param("id").isInt({ min: 0 })])], articlesController.markRead);

export default router;
