import express from "express";
import * as buildingsController from "../controllers/buildings.controller";
import verifyToken from "../middleware/auth.middleware";

// The admin routes (cache status, refresh, prefetch, clear) are in admin.route.ts under /admin/buildings
const router = express.Router();

router.get("/:z/:x/:y.pbf", [verifyToken], buildingsController.getTile);

export default router;
