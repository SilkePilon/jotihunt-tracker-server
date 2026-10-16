import express from "express";
import { query } from "express-validator";
import * as huntsController from "../controllers/hunts.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

const router = express.Router();

// Web sessions and paired phones (device tokens) alike
router.get("/", verifyToken, huntsController.getHunts);
router.get("/sync", verifyToken, huntsController.getHuntSync);
router.get(
  "/events",
  [
    verifyToken,
    validate([
      query("limit").optional().isInt({ min: 1, max: 200 }).withMessage("Limit moet 1 tot 200 zijn."),
      query("before").optional().isISO8601().withMessage("before moet een ISO-tijd zijn."),
    ]),
  ],
  huntsController.getHuntEvents,
);

export default router;
