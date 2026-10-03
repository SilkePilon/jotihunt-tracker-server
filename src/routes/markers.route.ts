import express from "express";
import { body, param } from "express-validator";
import * as markersController from "../controllers/markers.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { AREAS } from "../constants/areas";
import { MarkerType } from "../models/marker.model";

const createValidator = [
  body("area").isIn(AREAS).withMessage(`Area must be any of the following: ${AREAS.join(", ")}`),
  body("type").isIn(Object.values(MarkerType)).withMessage(`Type must be any of the following: ${Object.values(MarkerType).join(", ")}`),
  body("time").isISO8601().withMessage("Time must be a valid date").toDate(),
  body("location.coordinates").isArray({ min: 2, max: 2 }).withMessage("Coordinates must be an array of [longitude, latitude]"),
  body("location.coordinates[0]").isFloat({ min: -180, max: 180 }).withMessage("Longitude is invalid").toFloat(),
  body("location.coordinates[1]").isFloat({ min: -90, max: 90 }).withMessage("Latitude is invalid").toFloat(),
];

const router = express.Router();

router.get("/", verifyToken, markersController.getMarkers);
router.post("/", [verifyToken, limitUserWrites(), validate(createValidator)], markersController.createMarker);
router.delete("/:id", [verifyToken, validate([param("id").isMongoId().withMessage("Invalid marker id")])], markersController.deleteMarker);

export default router;
