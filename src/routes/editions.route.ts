import express from "express";
import { body } from "express-validator";
import * as editionsController from "../editions/editions.controller";
import { waitForSwitch } from "../editions/database-switch";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

// Mounted before the edition gate: these requests are not counted by a switch (the POSTs run the switch themselves)
const router = express.Router();

router.get("/", [waitForSwitch, verifyToken], editionsController.getEditions);
router.post("/", [waitForSwitch, verifyToken, isAdmin], editionsController.postEdition);
router.post("/show", [waitForSwitch, verifyToken, isAdmin, validate([body("year").isInt({ min: 2000, max: 2100 }).withMessage("Kies een geldig jaar.")])], editionsController.postShowEdition);

export default router;
