import express from "express";
import * as adminController from "../controllers/admin.controller";
import * as adminAuthController from "../auth/admin-auth.controller";
import * as aiAdminController from "../controllers/ai-admin.controller";
import { INVITE_EXPIRY_KEYS, INVITE_MAX_USES } from "../auth/invites";
import * as buildingsController from "../controllers/buildings.controller";
import * as jotiboardController from "../controllers/jotiboard.controller";
import * as life360Controller from "../controllers/life360.controller";
import * as notificationsController from "../controllers/notifications.controller";
import * as telegramController from "../controllers/telegram.controller";
import * as trackerController from "../controllers/tracker.controller";
import { VEHICLES } from "../services/tracker-onboarding.helpers";
import verifyToken, { isAdmin } from "../middleware/auth.middleware";
import { body, param } from "express-validator";
import { User } from "../models/user.model";
import { validate } from "../middleware/validate.middleware";
import { AI_SLOTS } from "../settings/app-config";
import * as configController from "../settings/app-config.controller";
import { generalValidation, plainValidation, secretNameValidation, secretValidation } from "../settings/app-config.validation";

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
// Every admin route: signed in (401) and admin (403). Mounted under /admin only
router.use(verifyToken, isAdmin);

router.get("/users", adminController.getUsers);
router.get("/invites", adminAuthController.getInvites);
router.post(
  "/invites",
  validate([
    body("expiry").isIn(INVITE_EXPIRY_KEYS).withMessage("Ongeldige verlooptijd."),
    body("maxUses")
      .custom((value) => value === null || (INVITE_MAX_USES as readonly number[]).includes(value))
      .withMessage("Ongeldig aantal keer."),
  ]),
  adminAuthController.postInvite,
);
router.delete("/invites/:id", adminAuthController.deleteInvite);
router.post("/users/:id/recovery-link", adminAuthController.postRecoveryLink);
router.post("/broadcast", validate([body("message").isString().trim().isLength({ min: 1, max: 200 }).withMessage("Bericht moet 1 tot 200 tekens zijn.")]), notificationsController.broadcast);
router.get("/broadcasts", notificationsController.listBroadcasts);
// Linking the group's Telegram account (tegenhunts and other @Jotihunt_bot messages come in through it)
router.get("/telegram", telegramController.getStatus);
router.post("/telegram/link", telegramController.startLink);
router.delete("/telegram/link", telegramController.unlink);
router.post(
  "/telegram/password",
  validate([body("password").isString().withMessage("Wachtwoord mag niet leeg zijn.").bail().notEmpty().withMessage("Wachtwoord mag niet leeg zijn.")]),
  telegramController.submitPassword,
);
// Linking the team's Life360 circle (members without our app share their location through it)
router.get("/life360", life360Controller.getStatus);
router.post(
  "/life360/code",
  validate([body("email").isString().withMessage("E-mailadres is ongeldig.").bail().trim().toLowerCase().isEmail().withMessage("E-mailadres is ongeldig.")]),
  life360Controller.sendCode,
);
router.post(
  "/life360/verify",
  validate([
    body("code")
      .isString()
      .withMessage("De code is 6 cijfers.")
      .bail()
      .trim()
      .matches(/^\d{6}$/)
      .withMessage("De code is 6 cijfers."),
  ]),
  life360Controller.verifyCode,
);
router.post("/life360/circle", validate([body("circleId").isString().withMessage("Kies een kring.").bail().trim().notEmpty().withMessage("Kies een kring.")]), life360Controller.chooseCircle);
router.post(
  "/life360/token",
  validate([body("token").isString().withMessage("Token mag niet leeg zijn.").bail().trim().notEmpty().withMessage("Token mag niet leeg zijn.")]),
  life360Controller.pasteToken,
);
router.post("/life360/refresh", life360Controller.refresh);
router.delete("/life360/link", life360Controller.unlink);
// Jotiboard (jotiboard.nl): fox pins and hint solutions are imported every 20 s while sync is on
router.get("/jotiboard", jotiboardController.getStatus);
router.post(
  "/jotiboard/link",
  validate([
    body("username").isString().withMessage("Vul gebruikersnaam en wachtwoord in.").bail().trim().notEmpty().withMessage("Vul gebruikersnaam en wachtwoord in."),
    body("password").isString().withMessage("Vul gebruikersnaam en wachtwoord in.").bail().notEmpty().withMessage("Vul gebruikersnaam en wachtwoord in."),
  ]),
  jotiboardController.link,
);
router.delete("/jotiboard/link", jotiboardController.unlink);
router.patch("/jotiboard", validate([body("syncEnabled").isBoolean({ strict: true }).withMessage("syncEnabled moet true of false zijn.")]), jotiboardController.setSync);
router.delete("/jotiboard/imports", jotiboardController.purge);
// 3D buildings: the tile cache (3DBAG) and the jobs that fill it
router.get("/buildings", buildingsController.getStatus);
router.post("/buildings/refresh", buildingsController.refresh);
router.post(
  "/buildings/prefetch",
  validate([
    body("lat").isFloat({ min: -90, max: 90 }).withMessage("Ongeldige locatie."),
    body("lon").isFloat({ min: -180, max: 180 }).withMessage("Ongeldige locatie."),
    body("radiusKm").isFloat({ min: 1, max: 25 }).withMessage("Straal moet tussen 1 en 25 km liggen."),
  ]),
  buildingsController.prefetch,
);
router.delete("/buildings", buildingsController.clear);
router.delete("/users/:id", validate(deleteValidator), adminController.deleteUser);
router.put("/users/:id", validate(updateValidator), adminController.updateUser);
router.put(
  "/devices/:id/vehicle",
  validate([param("id").isInt({ min: 1 }).withMessage("Ongeldig toestel-ID."), body("vehicle").isIn(VEHICLES).withMessage("Voertuig moet walking, bike, car of motorcycle zijn.")]),
  trackerController.putDeviceVehicle,
);
// Settings that used to be env vars (Beheer → Algemeen / AI / Koppelingen)
router.get("/config", configController.getAdminConfig);
router.put("/config/general", validate(generalValidation), configController.putGeneral);
router.put("/config/plain", validate(plainValidation), configController.putPlain);
router.put("/config/secrets/:name", validate(secretValidation), configController.putSecret);
router.delete("/config/secrets/:name", validate(secretNameValidation), configController.deleteSecret);
router.post("/config/logo", configController.parseLogo, configController.postLogo);
router.get("/traccar/groups", configController.getTraccarGroups);
// Beheer → Algemeen: try the Jotihunt website login (posted or saved) in a fresh browser
router.post("/jotihunt/test-login", configController.postJotihuntTestLogin);
// Beheer → AI: Google's model list, the model per AI function, and a test call per function
router.get("/ai/models", aiAdminController.getModels);
router.put(
  "/ai/models",
  validate([
    body("models").isObject().withMessage("Modellen zijn ongeldig."),
    body("models")
      .custom((models) => Object.keys(models).every((slot) => (AI_SLOTS as readonly string[]).includes(slot)))
      .withMessage("Onbekende AI-functie."),
    ...AI_SLOTS.map((slot) =>
      body(`models.${slot}`)
        .optional({ values: "null" })
        .isString()
        .matches(/^[a-z0-9.\-]{3,80}$/)
        .withMessage("Ongeldig model."),
    ),
  ]),
  aiAdminController.putModels,
);
router.post("/ai/test/:slot", validate([param("slot").isIn(AI_SLOTS).withMessage("Onbekende AI-functie.")]), aiAdminController.testModel);

export default router;
