import express from "express";
import { body, param } from "express-validator";
import * as assignmentsController from "../controllers/assignments.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { AssignmentStatus } from "../models/assignment.model";

const articleParam = param("articleId").isInt({ min: 0 });
const overwrite = body("overwrite").optional().isBoolean();
// The key must be there: null (nobody) or a user id. Without it a body-less request would unassign.
const owner = body("owner")
  .exists()
  .bail()
  .if((value: unknown) => value !== null)
  .isMongoId();

// Shared by all assignment writes (status, owner, notes)
const assignmentWrites = limitUserWrites(60);

const router = express.Router();

router.get("/", verifyToken, assignmentsController.list);
router.get("/members", verifyToken, assignmentsController.members);
router.post(
  "/:articleId/status",
  [verifyToken, assignmentWrites, validate([articleParam, body("status").isIn(Object.values(AssignmentStatus)), overwrite])],
  assignmentsController.setStatus,
);
router.post(
  "/:articleId/owner",
  [verifyToken, assignmentWrites, validate([articleParam, owner, overwrite])],
  assignmentsController.setOwner,
);
router.post(
  "/:articleId/notes",
  [verifyToken, assignmentWrites, validate([articleParam, body("text").isString().trim().isLength({ min: 1, max: 1000 })])],
  assignmentsController.addNote,
);

export default router;
