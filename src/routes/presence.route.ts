import express from "express";
import { body } from "express-validator";
import * as presenceController from "../controllers/presence.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { DEFAULT_AREAS } from "../services/hint-parser";

const router = express.Router();

router.post(
  "/",
  [verifyToken, limitUserWrites(60), validate([body("itemId").isInt({ min: 0 }), body("area").optional().isString().toLowerCase().isIn(DEFAULT_AREAS)])],
  presenceController.beat,
);
router.delete("/", verifyToken, presenceController.leave);

export default router;
