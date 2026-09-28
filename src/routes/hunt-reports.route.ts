import express from "express";
import { body, param } from "express-validator";
import * as huntReportsController from "../controllers/hunt-reports.controller";
import verifyToken from "../middleware/auth.middleware";
import { photoUpload } from "../middleware/photo-upload.middleware";
import { validate } from "../middleware/validate.middleware";
import { HUNT_AREAS, HUNT_KINDS } from "../services/hunt-report.helpers";

const router = express.Router();

const idParam = param("id").isMongoId().withMessage("Ongeldig hunt-ID.");

router.get("/", verifyToken, huntReportsController.getHuntReports);
router.post(
  "/",
  [
    verifyToken,
    photoUpload,
    validate([
      body("huntCode").isString().trim().isLength({ min: 1, max: 64 }).withMessage("Huntcode ontbreekt."),
      body("huntTime").isISO8601().withMessage("Ongeldige tijd."),
      body("area").isIn(HUNT_AREAS).withMessage("Onbekend deelgebied."),
      body("kind").isIn(HUNT_KINDS).withMessage("Soort moet hunt of tegenhunt zijn."),
      body("lng").optional().isFloat({ min: -180, max: 180 }).withMessage("Ongeldige lengtegraad."),
      body("lat").optional().isFloat({ min: -90, max: 90 }).withMessage("Ongeldige breedtegraad."),
    ]),
  ],
  huntReportsController.postHuntReport,
);
router.put(
  "/:id/submitted",
  [verifyToken, validate([idParam, body("submitted").isBoolean({ strict: true }).withMessage("submitted moet true of false zijn.")])],
  huntReportsController.putSubmitted,
);
router.delete("/:id", [verifyToken, validate([idParam])], huntReportsController.deleteReport);
router.get("/:id/photo", [verifyToken, validate([idParam])], huntReportsController.getPhoto);

export default router;
