import { body, param } from "express-validator";
import { PLAIN_NAMES, SECRET_NAMES, VEHICLE_KEYS } from "./app-config";

const optionalNullable = { values: "null" as const };
/** http(s) URL or a site path; never javascript: etc. */
const isSafeUrl = (value: string) => value === "" || (value.startsWith("/") && !/^\/[\\/]/.test(value)) || /^https?:\/\/[^\s]+$/i.test(value);

export const generalValidation = [
  body("huntStart").optional(optionalNullable).isISO8601().withMessage("Start is geen geldige datum."),
  body("huntEnd")
    .optional(optionalNullable)
    .isISO8601()
    .withMessage("Einde is geen geldige datum.")
    .bail()
    .custom((end, { req }) => !req.body.huntStart || new Date(end) > new Date(req.body.huntStart))
    .withMessage("Einde moet na de start liggen."),
  body("homeTeamApiId").optional(optionalNullable).isInt({ min: 1 }).withMessage("Kies een team."),
  body("groupName").optional(optionalNullable).isString().trim().isLength({ max: 60 }).withMessage("Groepsnaam is maximaal 60 tekens."),
  body("logoUrl").optional(optionalNullable).isString().trim().custom(isSafeUrl).withMessage("Logo moet een http(s)-link of /pad zijn."),
  body("discordUrl").optional(optionalNullable).isString().trim().custom(isSafeUrl).withMessage("Discord-link moet met https:// beginnen."),
  body("vehicleGroups").optional().isObject().withMessage("Voertuiggroepen zijn ongeldig."),
  ...VEHICLE_KEYS.map((vehicle) => body(`vehicleGroups.${vehicle}`).optional(optionalNullable).isInt({ min: 1 }).withMessage("Kies een Traccar-groep.")),
];

export const secretValidation = [
  param("name").isIn(SECRET_NAMES).withMessage("Onbekende instelling."),
  // hide(): express-validator echoes the value in its errors; a secret must never come back
  body("value").hide().isString().trim().isLength({ min: 1, max: 500 }).withMessage("Vul een waarde in."),
];

export const secretNameValidation = [param("name").isIn(SECRET_NAMES).withMessage("Onbekende instelling.")];

export const plainValidation = [
  body().custom((value) => Object.keys(value ?? {}).every((key) => (PLAIN_NAMES as readonly string[]).includes(key))).withMessage("Onbekende instelling."),
  body("telegramApiId").optional(optionalNullable).isInt({ min: 1 }).withMessage("API ID is een getal."),
  body("jotihuntWebUsername").optional(optionalNullable).isString().trim().isLength({ max: 200 }),
  body("telegramBotUsername").optional(optionalNullable).isString().trim().matches(/^@?[A-Za-z0-9_]{3,64}$/).withMessage("Ongeldige botnaam."),
];
