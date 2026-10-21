import express from "express";
import { param, query } from "express-validator";
import * as areasController from "../controllers/areas.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

router.get("/", verifyToken, areasController.getAreas);
router.get(
  "/:area/history",
  [verifyToken, validate([param("area").isString().isLength({ min: 1, max: 20 }), query("minutes").optional().isInt({ min: 10, max: 600 })])],
  areasController.getAreaHistory,
);

export default router;
