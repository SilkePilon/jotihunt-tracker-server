import express from "express";
import * as configController from "../settings/app-config.controller";

const router = express.Router();
// Public: the invite and login pages need the group name and logo before anyone is signed in
router.get("/config", configController.getPublicConfig);
router.get("/branding/logo", configController.getLogo);

export default router;
