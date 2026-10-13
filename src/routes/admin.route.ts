import express from "express";
import * as adminController from "../controllers/admin.controller";
import * as life360Controller from "../controllers/life360.controller";
import * as notificationsController from "../controllers/notifications.controller";
import * as telegramController from "../controllers/telegram.controller";
import * as trackerController from "../controllers/tracker.controller";
import { VEHICLES } from "../services/tracker-onboarding.helpers";
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
// Linking the group's Telegram account (tegenhunts and other @Jotihunt_bot messages come in through it)
router.get("/telegram", [verifyToken, isAdmin], telegramController.getStatus);
router.post("/telegram/link", [verifyToken, isAdmin], telegramController.startLink);
router.delete("/telegram/link", [verifyToken, isAdmin], telegramController.unlink);
router.post(
  "/telegram/password",
  [verifyToken, isAdmin, validate([body("password").isString().withMessage("Wachtwoord mag niet leeg zijn.").bail().notEmpty().withMessage("Wachtwoord mag niet leeg zijn.")])],
  telegramController.submitPassword,
);
// Linking the team's Life360 circle (members without our app share their location through it)
router.get("/life360", [verifyToken, isAdmin], life360Controller.getStatus);
router.post(
  "/life360/code",
  [verifyToken, isAdmin, validate([body("email").isString().withMessage("E-mailadres is ongeldig.").bail().trim().toLowerCase().isEmail().withMessage("E-mailadres is ongeldig.")])],
  life360Controller.sendCode,
);
router.post(
  "/life360/verify",
  [verifyToken, isAdmin, validate([body("code").isString().withMessage("De code is 6 cijfers.").bail().trim().matches(/^\d{6}$/).withMessage("De code is 6 cijfers.")])],
  life360Controller.verifyCode,
);
router.post(
  "/life360/circle",
  [verifyToken, isAdmin, validate([body("circleId").isString().withMessage("Kies een kring.").bail().trim().notEmpty().withMessage("Kies een kring.")])],
  life360Controller.chooseCircle,
);
router.post(
  "/life360/token",
  [verifyToken, isAdmin, validate([body("token").isString().withMessage("Token mag niet leeg zijn.").bail().trim().notEmpty().withMessage("Token mag niet leeg zijn.")])],
  life360Controller.pasteToken,
);
router.post("/life360/refresh", [verifyToken, isAdmin], life360Controller.refresh);
router.delete("/life360/link", [verifyToken, isAdmin], life360Controller.unlink);
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
