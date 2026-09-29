import express from "express";
import { body } from "express-validator";
import * as demoController from "../demo/demo.controller";
import { waitForDemoSwitch } from "../demo/database-switch";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

// Mounted before the demo gate: these requests are not counted by a switch (POST /demo runs the switch itself)
const router = express.Router();

router.get("/", [waitForDemoSwitch, verifyToken], demoController.getDemo);
router.post("/", [waitForDemoSwitch, verifyToken, isAdmin, validate([body("enabled").isBoolean({ strict: true }).withMessage("Enabled moet true of false zijn.")])], demoController.postDemo);

export default router;
