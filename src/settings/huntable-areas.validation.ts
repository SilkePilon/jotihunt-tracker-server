import { body } from "express-validator";
import { AREAS } from "../constants/areas";

const UNKNOWN_AREA = `Onbekend deelgebied; kies uit ${AREAS.join(", ")}.`;

/** Body of PUT /settings/huntable-areas: `{ areas: string[] }` with lowercase area names (duplicates are fine, removed on save). */
export const huntableAreasValidation = [
  body("areas").isArray({ max: 50 }).withMessage("Areas moet een lijst met deelgebieden zijn."),
  body("areas.*").isString().withMessage(UNKNOWN_AREA).bail().isIn(AREAS).withMessage(UNKNOWN_AREA),
];
