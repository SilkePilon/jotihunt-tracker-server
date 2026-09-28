import express from "express";
import * as leaderboardController from "../controllers/leaderboard.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();
router.get("/", verifyToken, leaderboardController.getLeaderboard);
export default router;
