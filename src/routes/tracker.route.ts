import express from "express";
import { body } from "express-validator";
import * as pairingController from "../controllers/pairing.controller";
import * as trackerController from "../controllers/tracker.controller";
import verifyToken from "../middleware/auth.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { validate } from "../middleware/validate.middleware";
import { VEHICLES } from "../services/tracker-onboarding.helpers";

const router = express.Router();

router.get("/devices", verifyToken, trackerController.getDevices);
router.get("/positions", verifyToken, trackerController.getPositions);
router.get("/me", verifyToken, trackerController.getMe);
// A one-time code for the QR that pairs the Android app
router.post("/pair", [verifyToken, limitUserWrites(10)], pairingController.createCode);
router.put(
  "/me/vehicle",
  [verifyToken, validate([body("vehicle").isIn(VEHICLES).withMessage("Voertuig moet walking, bike, car of motorcycle zijn.")])],
  trackerController.putVehicle,
);

export default router;
