import express from "express";
import { body, param } from "express-validator";
import * as huntReportsController from "../controllers/hunt-reports.controller";
import verifyToken from "../middleware/auth.middleware";
import { photoUpload } from "../middleware/photo-upload.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { HUNT_AREAS } from "../services/hunt-report.helpers";

const router = express.Router();

const idParam = param("id").isMongoId().withMessage("Ongeldig hunt-ID.");

router.get("/", verifyToken, huntReportsController.getHuntReports);
router.post(
  "/",
  [
    verifyToken,
    // Before parsing the upload, so a flood is refused without reading 5 MB bodies
    limitUserWrites(),
    photoUpload,
    validate([
      // Code and time are read from the photo by OCR; entering them is optional
      body("huntCode").optional({ values: "falsy" }).isString().trim().isLength({ min: 1, max: 64 }).withMessage("Ongeldige huntcode."),
      body("huntTime").optional({ values: "falsy" }).isISO8601().withMessage("Ongeldige tijd."),
      body("area").isIn(HUNT_AREAS).withMessage("Onbekend deelgebied."),
      body("lng").optional().isFloat({ min: -180, max: 180 }).withMessage("Ongeldige lengtegraad."),
      body("lat").optional().isFloat({ min: -90, max: 90 }).withMessage("Ongeldige breedtegraad."),
      body("uploadId").optional().isUUID().withMessage("Ongeldig upload-ID."),
    ]),
  ],
  huntReportsController.postHuntReport,
);
router.put(
  "/:id/submitted",
  [verifyToken, validate([idParam, body("submitted").isBoolean({ strict: true }).withMessage("submitted moet true of false zijn.")])],
  huntReportsController.putSubmitted,
);
// HQ corrections (admin check in the service, like status and delete)
router.patch(
  "/:id",
  [
    verifyToken,
    validate([
      idParam,
      body("huntCode").optional().isString().trim().isLength({ min: 1, max: 64 }).withMessage("Huntcode moet 1 tot 64 tekens zijn."),
      body("huntTime").optional().isISO8601().withMessage("Ongeldige tijd."),
    ]),
  ],
  huntReportsController.patchReport,
);
router.post("/:id/read", [verifyToken, validate([idParam])], huntReportsController.postRead);
router.delete("/:id", [verifyToken, validate([idParam])], huntReportsController.deleteReport);
router.get("/:id/photo", [verifyToken, validate([idParam])], huntReportsController.getPhoto);

export default router;
