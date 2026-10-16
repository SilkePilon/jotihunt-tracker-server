import express from "express";
import { body, param, query } from "express-validator";
import * as hintsController from "../controllers/hints.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { limitUserWrites } from "../middleware/rate-limit";
import { DEFAULT_AREAS } from "../services/hint-parser";

const cellParams = [param("articleId").isInt({ min: 0 }), param("area").isIn(DEFAULT_AREAS)];

const router = express.Router();

router.get("/board", verifyToken, hintsController.getBoard);
router.get(
  "/parse-answer",
  [verifyToken, validate([query("answer").optional().isString().isLength({ max: 200 })])],
  hintsController.parseAnswer,
);
router.post(
  "/:articleId/:area/solve",
  [
    verifyToken,
    limitUserWrites(60),
    validate([
      ...cellParams,
      body("answer").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Antwoord is verplicht."),
      body("replaceMarker").optional().isBoolean(),
    ]),
  ],
  hintsController.solve,
);
router.delete("/:articleId/:area/solve", [verifyToken, limitUserWrites(60), validate(cellParams)], hintsController.clear);

export default router;
