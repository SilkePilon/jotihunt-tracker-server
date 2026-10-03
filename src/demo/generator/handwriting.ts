import type { Rng } from "./prng";

/** Pen strokes per character in a 30×50 box (y down). */
const GLYPHS: Record<string, [number, number][][]> = {
  "0": [Array.from({ length: 15 }, (_, i) => [15 + 12 * Math.sin((i / 14) * Math.PI * 2 + 0.3), 25 - 23 * Math.cos((i / 14) * Math.PI * 2 + 0.3)] as [number, number])],
  "1": [
    [
      [7, 12],
      [17, 2],
      [16, 48],
    ],
  ],
  "2": [
    [
      [4, 12],
      [10, 3],
      [20, 2],
      [27, 10],
      [24, 21],
      [4, 47],
      [29, 46],
    ],
  ],
  "3": [
    [
      [4, 7],
      [15, 1],
      [26, 8],
      [23, 19],
      [12, 24],
      [25, 29],
      [28, 40],
      [18, 49],
      [3, 44],
    ],
  ],
  "4": [
    [
      [20, 2],
      [2, 33],
      [29, 33],
    ],
    [
      [21, 14],
      [21, 49],
    ],
  ],
  "5": [
    [
      [27, 2],
      [8, 3],
      [5, 22],
      [17, 18],
      [27, 27],
      [26, 41],
      [15, 49],
      [3, 44],
    ],
  ],
  "6": [
    [
      [25, 4],
      [14, 2],
      [5, 15],
      [3, 34],
      [9, 47],
      [20, 48],
      [27, 38],
      [24, 27],
      [13, 25],
      [4, 33],
    ],
  ],
  "7": [
    [
      [3, 3],
      [28, 2],
      [12, 48],
    ],
  ],
  "8": [
    [
      [15, 24],
      [6, 15],
      [8, 4],
      [18, 1],
      [26, 8],
      [23, 18],
      [15, 24],
      [5, 33],
      [6, 45],
      [16, 49],
      [26, 43],
      [26, 31],
      [15, 24],
    ],
  ],
  "9": [
    [
      [26, 16],
      [18, 23],
      [7, 20],
      [5, 9],
      [14, 1],
      [24, 4],
      [27, 15],
      [24, 33],
      [16, 49],
    ],
  ],
};

/** Smooth path through the points (Catmull-Rom as cubic Béziers). */
function smoothPath(points: [number, number][]): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** SVG of a handwritten "HH:MM" in blue ballpoint (slanted, wobbly, uneven spacing). */
export function handwrittenTimeSvg(time: string, rng: Rng, height = 64): string {
  const scale = height / 50;
  let x = 4;
  const paths: string[] = [];
  const dots: string[] = [];
  for (const char of time) {
    if (char === ":") {
      for (const y of [17, 38]) dots.push(`<circle cx="${(x + 3 + rng.range(-1, 1)).toFixed(1)}" cy="${(y + rng.range(-2, 2)).toFixed(1)}" r="2.4"/>`);
      x += 10 + rng.range(-1, 2);
      continue;
    }
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    const size = rng.range(0.85, 1.08);
    const dy = rng.range(-3, 3);
    for (const stroke of glyph) {
      const jittered = stroke.map(([px, py]) => [x + px * size + rng.range(-1.2, 1.2), dy + py * size + rng.range(-1.2, 1.2)] as [number, number]);
      paths.push(`<path d="${smoothPath(jittered)}"/>`);
    }
    x += 30 * size + rng.range(2, 7);
  }
  const width = x + 8;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(width * scale).toFixed(0)}" height="${((50 + 12) * scale).toFixed(0)}" viewBox="-2 -6 ${width.toFixed(0)} 62">` +
    `<g transform="skewX(-14)" fill="none" stroke="#2743b8" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round" opacity="0.88">${paths.join("")}</g>` +
    `<g transform="skewX(-14)" fill="#2743b8" opacity="0.88">${dots.join("")}</g></svg>`
  );
}
