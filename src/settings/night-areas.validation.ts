import { body } from "express-validator";

const isRing = (ring: unknown) =>
  Array.isArray(ring) && ring.length >= 4 && ring.length <= 500 &&
  ring.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))) &&
  ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];

export const nightAreasValidation = [
  body("enabled").isBoolean({ strict: true }).withMessage("Enabled moet true of false zijn."),
  body("areas").isArray({ max: 50 }).withMessage("Maximaal 50 gebieden."),
  body("areas.*.id").isString().isLength({ min: 1, max: 40 }),
  body("areas.*.name").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Geef het gebied een naam."),
  body("areas.*.kind").isIn(["closed", "open"]),
  body("areas.*.polygon").custom((polygon) => polygon?.type === "Polygon" && Array.isArray(polygon.coordinates) && polygon.coordinates.length === 1 && isRing(polygon.coordinates[0])).withMessage("Ongeldig gebied."),
];
