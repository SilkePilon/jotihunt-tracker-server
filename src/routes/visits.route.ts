import express from "express";
import { body, param } from "express-validator";
import * as predictionsController from "../controllers/predictions.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

router.get("/", verifyToken, predictionsController.getVisits);
router.put(
  "/:teamApiId",
  [
    verifyToken,
    validate([
      param("teamApiId").isInt({ min: 0 }).withMessage("Ongeldig groeps-ID."),
      body("state").isIn(["visited", "not_visited", "auto"]).withMessage("Status moet visited, not_visited of auto zijn."),
    ]),
  ],
  predictionsController.putVisit,
);

export default router;
