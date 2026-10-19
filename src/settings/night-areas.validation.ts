import { body } from "express-validator";

const isRing = (ring: unknown) =>
  Array.isArray(ring) && ring.length >= 4 && ring.length <= 500 &&
  ring.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))) &&
  ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];

type Pt = [number, number];
const orient = (a: Pt, b: Pt, c: Pt) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Pt, b: Pt, p: Pt) =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/** True when two non-adjacent edges of the closed ring cross or touch (a "bow tie" or a pinched ring). */
export function ringSelfIntersects(ring: Pt[]): boolean {
  const edges = ring.length - 1;
  for (let i = 0; i < edges; i++) {
    for (let j = i + 1; j < edges; j++) {
      // Neighbouring edges share a corner (the first and last edge too)
      if (j === i + 1 || (i === 0 && j === edges - 1)) continue;
      if (segmentsTouch(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

export const nightAreasValidation = [
  body("enabled").isBoolean({ strict: true }).withMessage("Enabled moet true of false zijn."),
  body("areas").isArray({ max: 50 }).withMessage("Maximaal 50 gebieden."),
  body("areas.*.id").isString().isLength({ min: 1, max: 40 }),
  body("areas.*.name").isString().trim().isLength({ min: 1, max: 60 }).withMessage("Geef het gebied een naam."),
  body("areas.*.kind").isIn(["closed", "open"]),
  body("areas.*.polygon").custom((polygon) => polygon?.type === "Polygon" && Array.isArray(polygon.coordinates) && polygon.coordinates.length === 1 && isRing(polygon.coordinates[0])).withMessage("Ongeldig gebied.")
    .bail()
    .custom((polygon) => !ringSelfIntersects(polygon.coordinates[0])).withMessage("Gebied mag zichzelf niet kruisen."),
];
