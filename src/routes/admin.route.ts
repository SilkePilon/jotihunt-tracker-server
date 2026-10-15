import express from "express";
import * as adminController from "../controllers/admin.controller";
import * as adminAuthController from "../auth/admin-auth.controller";
import { INVITE_EXPIRY_KEYS, INVITE_MAX_USES } from "../auth/invites";
import * as buildingsController from "../controllers/buildings.controller";
import * as life360Controller from "../controllers/life360.controller";
import * as notificationsController from "../controllers/notifications.controller";
import * as telegramController from "../controllers/telegram.controller";
import * as trackerController from "../controllers/tracker.controller";
import { VEHICLES } from "../services/tracker-onboarding.helpers";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { body, param } from "express-validator";
import { User } from "../models/user.model";
import { validate } from "../middleware/validate.middleware";

// Validations
const userExists = (value: string) =>
  User.exists({ _id: value }).then((user) => {
    if (!user) throw new Error("Er is geen gebruiker met dit ID.");
  });

const deleteValidator = [param("id").isMongoId().withMessage("Ongeldig gebruikers-ID.").bail().custom(userExists)];

const updateValidator = [
  param("id").isMongoId().withMessage("Ongeldig gebruikers-ID.").bail().custom(userExists),
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Naam mag niet leeg zijn.")
    .bail()
    .isLength({ max: 40 })
    .withMessage("Naam moet 1 tot 40 tekens zijn."),
  body("admin").optional().isBoolean().withMessage("Admin mag alleen true/false zijn.").toBoolean(),
];

// Routes
const router = express.Router();

router.get("/users", [verifyToken, isAdmin], adminController.getUsers);
router.get("/invites", [verifyToken, isAdmin], adminAuthController.getInvites);
router.post(
  "/invites",
  [
    verifyToken,
    isAdmin,
    validate([
      body("expiry").isIn(INVITE_EXPIRY_KEYS).withMessage("Ongeldige verlooptijd."),
      body("maxUses")
        .custom((value) => value === null || (INVITE_MAX_USES as readonly number[]).includes(value))
        .withMessage("Ongeldig aantal keer."),
    ]),
  ],
  adminAuthController.postInvite,
);
router.delete("/invites/:id", [verifyToken, isAdmin], adminAuthController.deleteInvite);
router.post("/users/:id/recovery-link", [verifyToken, isAdmin], adminAuthController.postRecoveryLink);
router.post(
  "/broadcast",
  [verifyToken, isAdmin, validate([body("message").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Bericht moet 1 tot 200 tekens zijn.")])],
  notificationsController.broadcast,
);
router.get("/broadcasts", [verifyToken, isAdmin], notificationsController.listBroadcasts);
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
  [
    verifyToken,
    isAdmin,
    validate([
      body("code")
        .isString()
        .withMessage("De code is 6 cijfers.")
        .bail()
        .trim()
        .matches(/^\d{6}$/)
        .withMessage("De code is 6 cijfers."),
    ]),
  ],
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
// 3D buildings: the tile cache (3DBAG) and the jobs that fill it
router.get("/buildings", [verifyToken, isAdmin], buildingsController.getStatus);
router.post("/buildings/refresh", [verifyToken, isAdmin], buildingsController.refresh);
router.post(
  "/buildings/prefetch",
  [
    verifyToken,
    isAdmin,
    validate([
      body("lat").isFloat({ min: -90, max: 90 }).withMessage("Ongeldige locatie."),
      body("lon").isFloat({ min: -180, max: 180 }).withMessage("Ongeldige locatie."),
      body("radiusKm").isFloat({ min: 1, max: 25 }).withMessage("Straal moet tussen 1 en 25 km liggen."),
    ]),
  ],
  buildingsController.prefetch,
);
router.delete("/buildings", [verifyToken, isAdmin], buildingsController.clear);
router.delete("/users/:id", [verifyToken, isAdmin, validate(deleteValidator)], adminController.deleteUser);
router.put("/users/:id", [verifyToken, isAdmin, validate(updateValidator)], adminController.updateUser);
router.put(
  "/devices/:id/vehicle",
  [
    verifyToken,
    isAdmin,
    validate([param("id").isInt({ min: 1 }).withMessage("Ongeldig toestel-ID."), body("vehicle").isIn(VEHICLES).withMessage("Voertuig moet walking, bike, car of motorcycle zijn.")]),
  ],
  trackerController.putDeviceVehicle,
);

export default router;
