import express from "express";
import { body, param } from "express-validator";
import * as trailsController from "../controllers/trails.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

router.get("/trails", verifyToken, trailsController.getTrails);
router.patch(
  "/legs/:markerId",
  [
    verifyToken,
    validate([
      param("markerId").isMongoId().withMessage("Invalid marker id"),
      body("legMode").custom((v) => v === null || v === "walk" || v === "car").withMessage("legMode moet walk, car of null zijn."),
    ]),
  ],
  trailsController.setLegMode,
);

export default router;
