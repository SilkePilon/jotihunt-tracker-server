import express from "express";
import { body, param, query } from "express-validator";
import * as hintsController from "../controllers/hints.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { HintCellStatus, HintCheck } from "../models/hint-cell.model";
import { DEFAULT_AREAS } from "../services/hint-parser";

const cellParams = [param("articleId").isInt({ min: 0 }), param("area").isIn(DEFAULT_AREAS)];

const router = express.Router();

router.get("/board", verifyToken, hintsController.getBoard);
router.get(
  "/parse-answer",
  [verifyToken, validate([query("answer").optional().isString().isLength({ max: 200 })])],
  hintsController.parseAnswer,
);
router.post("/:articleId/:area/claim", [verifyToken, validate(cellParams)], hintsController.claim);
router.post("/:articleId/:area/release", [verifyToken, validate(cellParams)], hintsController.release);
router.post(
  "/:articleId/:area/solve",
  [
    verifyToken,
    validate([
      ...cellParams,
      body("answer").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Antwoord is verplicht."),
      body("replaceMarker").optional().isBoolean(),
    ]),
  ],
  hintsController.solve,
);
router.post(
  "/:articleId/:area/check",
  [verifyToken, validate([...cellParams, body("check").isIn(Object.values(HintCheck))])],
  hintsController.check,
);
router.post(
  "/:articleId/:area/notes",
  [verifyToken, validate([...cellParams, body("text").isString().trim().isLength({ min: 1, max: 1000 })])],
  hintsController.addNote,
);
router.post(
  "/:articleId/:area/status",
  [verifyToken, validate([...cellParams, body("status").isIn([HintCellStatus.Open, HintCellStatus.None])])],
  hintsController.setStatus,
);

export default router;
