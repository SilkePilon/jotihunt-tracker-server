import express from "express";
import * as predictionsController from "../controllers/predictions.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

router.get("/", verifyToken, predictionsController.getPredictions);

export default router;
