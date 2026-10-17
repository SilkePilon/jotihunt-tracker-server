import express from "express";
import * as scoreController from "../controllers/score.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

// Web sessions and paired phones (device tokens) alike
router.get("/", verifyToken, scoreController.getScore);

export default router;
