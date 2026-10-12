import express from "express";
import * as adminController from "../controllers/admin.controller";
import * as notificationsController from "../controllers/notifications.controller";
import * as trackerController from "../controllers/tracker.controller";
import { VEHICLES } from "../services/tracker-onboarding.helpers";
import { COUNTER_HUNT_DIRECTIONS } from "../services/notifier.helpers";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { body, param } from "express-validator";
import { User } from "../models/user.model";
import { validate } from "../middleware/validate.middleware";
import { newPasswordRules } from "../utils/password-policy";

// Validations
const userExists = (value: string) =>
  User.exists({ _id: value }).then((user) => {
    if (!user) throw new Error("Er is geen gebruiker met dit ID.");
  });

const createValidator = [
  body("name").trim().notEmpty().withMessage("Naam mag niet leeg zijn."),
  body("email")
    .trim()
    .toLowerCase()
    .notEmpty()
    .withMessage("E-mailadres mag niet leeg zijn.")
    .bail()
    .isEmail()
    .withMessage("E-mailadres is ongeldig.")
    .bail()
    .custom(async (value) => {
      if (await User.exists({ email: value })) throw new Error("E-mailadres is al in gebruik.");
    }),
  body("password").isString().notEmpty().withMessage("Wachtwoord mag niet leeg zijn."),
  newPasswordRules(body("password")),
  body("admin").optional().isBoolean().withMessage("Admin mag alleen true/false zijn.").toBoolean(),
];

const deleteValidator = [param("id").isMongoId().withMessage("Ongeldig gebruikers-ID.").bail().custom(userExists)];

const updateValidator = [
  param("id").isMongoId().withMessage("Ongeldig gebruikers-ID.").bail().custom(userExists),
  body("name").optional().trim().notEmpty().withMessage("Naam mag niet leeg zijn."),
  body("email")
    .optional()
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage("E-mailadres is ongeldig.")
    .bail()
    .custom(async (value, { req }) => {
      const user = await User.findOne({ email: value }, { _id: 1 }).lean();
      if (user && user._id.toString() !== req.params?.id) throw new Error("E-mailadres is al in gebruik.");
    }),
  // Empty or missing: the password stays as it is (the edit dialog sends no password unless one is typed)
  newPasswordRules(body("password").optional({ values: "falsy" })),
  body("admin").optional().isBoolean().withMessage("Admin mag alleen true/false zijn.").toBoolean(),
];

// Routes
const router = express.Router();

router.get("/users", [verifyToken, isAdmin], adminController.getUsers);
router.post("/users", [verifyToken, isAdmin, validate(createValidator)], adminController.createUser);
router.post(
  "/broadcast",
  [verifyToken, isAdmin, validate([body("message").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Bericht moet 1 tot 200 tekens zijn.")])],
  notificationsController.broadcast,
);
router.post(
  "/counter-hunt",
  [verifyToken, isAdmin, validate([body("direction").isIn(COUNTER_HUNT_DIRECTIONS.map(String)).withMessage("Richting moet 0, 45, 90, ..., 315 zijn.").toInt()])],
  notificationsController.counterHunt,
);
router.delete("/users/:id", [verifyToken, isAdmin, validate(deleteValidator)], adminController.deleteUser);
router.put("/users/:id", [verifyToken, isAdmin, validate(updateValidator)], adminController.updateUser);
router.put(
  "/devices/:id/vehicle",
  [
    verifyToken,
    isAdmin,
    validate([
      param("id").isInt({ min: 1 }).withMessage("Ongeldig toestel-ID."),
      body("vehicle").isIn(VEHICLES).withMessage("Voertuig moet walking, bike, car of motorcycle zijn."),
    ]),
  ],
  trackerController.putDeviceVehicle,
);

export default router;
