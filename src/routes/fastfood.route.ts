import express from "express";
import * as fastfoodController from "../controllers/fastfood.controller";
import verifyToken from "../middleware/auth.middleware";

const router = express.Router();

router.get("/", [verifyToken], fastfoodController.list);

export default router;
