import proj4 from "proj4";

proj4.defs(
  "RD",
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs",
);

export interface RdAnswer {
  x: number;
  y: number;
  lng: number;
  lat: number;
}

/**
 * Parse a hint answer as an RD coordinate.
 * Accepts "1234 5678", "12345678", "123400 567800" and "123400567800" (separators: whitespace , ;).
 * @param text The answer as entered
 * @returns The RD and WGS84 coordinates, or null if the text is not a valid RD coordinate
 */
export function parseRdAnswer(text: string): RdAnswer | null {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  let xs: string;
  let ys: string;

  if (parts.length === 1 && /^(\d{8}|\d{12})$/.test(parts[0])) {
    const half = parts[0].length / 2;
    xs = parts[0].slice(0, half);
    ys = parts[0].slice(half);
  } else if (parts.length === 2 && parts[0].length === parts[1].length && parts.every((part) => /^(\d{4}|\d{6})$/.test(part))) {
    [xs, ys] = parts;
  } else {
    return null;
  }

  const x = xs.length === 4 ? Number(xs) * 100 : Number(xs);
  const y = ys.length === 4 ? Number(ys) * 100 : Number(ys);
  if (x < 0 || x > 290000 || y < 290000 || y > 630000) return null;

  const [lng, lat] = proj4("RD", "WGS84", [x, y]);
  return { x, y, lng, lat };
}

/** RD coordinates (metres) of a WGS84 position. */
export function toRd(lng: number, lat: number): { x: number; y: number } {
  const [x, y] = proj4("WGS84", "RD", [lng, lat]);
  return { x, y };
}

/**
 * Format a WGS84 position as an RD hint answer in hectometres, "XXXX YYYY" (the format parseRdAnswer reads back to
 * within ~71 m of the position).
 */
export function formatRdAnswer(lng: number, lat: number): string {
  const { x, y } = toRd(lng, lat);
  const part = (value: number) => String(Math.round(value / 100)).padStart(4, "0");
  return `${part(x)} ${part(y)}`;
}
