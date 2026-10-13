import express from "express";
import { param } from "express-validator";
import * as life360Controller from "../controllers/life360.controller";
import verifyToken from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";

// The admin routes (linking) are in admin.route.ts under /admin/life360
const router = express.Router();

router.get("/members", [verifyToken], life360Controller.getMembers);
// Proxied so browsers never contact Life360; verifyToken reads the Authorization header, so the client loads it as a blob
router.get(
  "/avatar/:memberId",
  [verifyToken, validate([param("memberId").isString().isLength({ min: 1, max: 100 }).withMessage("Ongeldig lid.")])],
  life360Controller.getAvatar,
);

export default router;
