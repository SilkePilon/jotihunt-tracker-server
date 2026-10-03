import express from "express";
import * as teamsController from "../controllers/teams.controller";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { body, param } from "express-validator";
import { Area } from "../models/area.model";
import { validate } from "../middleware/validate.middleware";

// Validations
const updateAreaValidator = [
  param("id").isMongoId().withMessage("Id must be a mongoId"),
  body("area").custom(async (value) => {
    if (!value) return;
    if (!(await Area.exists({ name: value }))) throw new Error("Area must exist in the areas table");
  }),
];

/** Area editing is a feature flag shared with the client (TEAMS_AREA_EDITING); admins can always edit */
function areaEditingAllowed(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (process.env.TEAMS_AREA_EDITING === "true" || req.user?.admin) return next();
  return res.status(403).json({ message: "Deelgebied aanpassen staat uit." });
}

const router = express.Router();

router.get("/", verifyToken, teamsController.getTeams);
router.put("/:id/area", [verifyToken, areaEditingAllowed, validate(updateAreaValidator)], teamsController.setTeamArea);
router.post("/reload", [verifyToken, isAdmin], teamsController.reloadTeams);

export default router;
