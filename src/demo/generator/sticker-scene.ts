import { createRng, type Rng } from "./prng";

/**
 * Photo-like scenes of a Jotihunt sticker (a white label on a torn backing strip) with the case-sensitive hunt code
 * and a handwritten blue time, rendered by headless Chromium (only the DejaVu fonts are needed; the handwriting is
 * drawn as SVG strokes). Used once to make the committed stickers in src/demo/stickers/ and by the demo generator to
 * render the stickers with the hunt times of the demo world.
 */

export type StickerBackground = "pavement" | "car" | "grass" | "wood";

export interface StickerDesign {
  code: string;
  /** Time written on the committed sticker, "HH:MM" */
  time: string;
  background: StickerBackground;
  /** Degrees */
  rotation: number;
  hand: "left" | "right" | "none";
  seed: number;
}

export const STICKER_WIDTH = 900;
export const STICKER_HEIGHT = 1200;

export const STICKER_DESIGNS: readonly StickerDesign[] = [
  { code: "GNcrZRZ", time: "11:17", background: "pavement", rotation: -3, hand: "left", seed: 11 },
  { code: "Gy3M8XI", time: "17:53", background: "car", rotation: 2, hand: "right", seed: 12 },
  { code: "kT7wQpL", time: "14:37", background: "grass", rotation: -6, hand: "none", seed: 13 },
  { code: "Rb4XnHe", time: "15:02", background: "wood", rotation: 4, hand: "none", seed: 14 },
  { code: "p9ZuVcA", time: "12:48", background: "pavement", rotation: 5, hand: "right", seed: 15 },
  { code: "Hq2sJmW", time: "19:26", background: "car", rotation: -4, hand: "left", seed: 16 },
  { code: "xE6aYdN", time: "13:09", background: "grass", rotation: 3, hand: "left", seed: 17 },
  { code: "Mf8tKgB", time: "16:44", background: "wood", rotation: -2, hand: "right", seed: 18 },
  { code: "uL3hPzS", time: "20:15", background: "pavement", rotation: -7, hand: "none", seed: 19 },
  { code: "Dw5rTyC", time: "10:31", background: "car", rotation: 6, hand: "none", seed: 20 },
];

/** File name of a committed sticker. */
export function stickerFileName(index: number): string {
  return `sticker-${String(index + 1).padStart(2, "0")}.jpg`;
}

// --- Handwriting ------------------------------------------------------------------------------------------------

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

// --- Backgrounds ------------------------------------------------------------------------------------------------

function noiseFilter(id: string, frequency: string, octaves: number, matrix: string, seed: number): string {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" seed="${seed}"/><feColorMatrix type="matrix" values="${matrix}"/></filter>`;
}

function pavement(rng: Rng, seed: number): string {
  // Clinker bricks in running bond (seen at an angle), dark joints, a few fallen leaves
  const bricks: string[] = [];
  const w = 132;
  const h = 58;
  for (let row = -12; row < 34; row++) {
    for (let col = -6; col < 14; col++) {
      const x = col * w + (row % 2 ? w / 2 : 0);
      const y = row * h;
      const shade = Math.round(rng.range(96, 132));
      bricks.push(`<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="9" fill="rgb(${shade},${shade - 3},${shade - 6})"/>`);
    }
  }
  const leaves = Array.from(
    { length: 22 },
    () =>
      `<ellipse cx="${rng.int(0, 900)}" cy="${rng.int(0, 1200)}" rx="${rng.int(10, 24)}" ry="${rng.int(6, 12)}" transform="rotate(${rng.int(-40, 40)})" fill="rgb(${rng.int(185, 215)},${rng.int(150, 178)},${rng.int(100, 128)})" opacity="0.9"/>`,
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><defs>${noiseFilter("n", "0.7", 2, "0 0 0 0 0.3  0 0 0 0 0.29  0 0 0 0 0.28  0 0 0 0.55 0", seed)}</defs>` +
    `<rect width="900" height="1200" fill="#46443f"/><g transform="rotate(-32 450 600)">${bricks.join("")}</g>${leaves.join("")}` +
    `<rect width="900" height="1200" filter="url(#n)"/></svg>`
  );
}

function car(rng: Rng, seed: number): string {
  const buttons = Array.from({ length: 5 }, (_, i) => `<rect x="${330 + i * 95}" y="${rng.int(318, 324)}" width="70" height="44" rx="8" fill="#1a1b1f" stroke="#34363c" stroke-width="2"/>`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><defs>` +
    noiseFilter("n", "0.8", 2, "0 0 0 0 0.2  0 0 0 0 0.2  0 0 0 0 0.22  0 0 0 0.5 0", seed) +
    `<radialGradient id="glow" cx="0.5" cy="0.25" r="0.6"><stop offset="0" stop-color="#3a3b44"/><stop offset="1" stop-color="#050506"/></radialGradient>` +
    `<linearGradient id="trim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9c9c98"/><stop offset="1" stop-color="#55544f"/></linearGradient>` +
    `<pattern id="perf" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#141416"/><circle cx="8" cy="8" r="2.2" fill="#505056"/></pattern></defs>` +
    `<rect width="900" height="1200" fill="url(#glow)"/>` +
    `<path d="M240 250 Q600 170 900 200 L900 290 Q600 260 250 320 Z" fill="url(#trim)"/>` +
    `<path d="M250 330 Q600 280 900 300 L900 316 Q600 300 250 350 Z" fill="#b3202a" opacity="0.8"/>` +
    buttons.join("") +
    `<polygon points="${330 + 3 * 95 + 35},326 ${330 + 3 * 95 + 22},352 ${330 + 3 * 95 + 48},352" fill="#e0262e"/>` +
    `<path d="M0 0 L230 0 Q280 600 170 1200 L0 1200 Z" fill="url(#perf)"/>` +
    `<path d="M600 1200 Q640 900 720 700 L900 640 L900 1200 Z" fill="#101013"/>` +
    `<circle cx="760" cy="1010" r="7" fill="#ff9a1f"/>` +
    `<rect width="900" height="1200" filter="url(#n)"/></svg>`
  );
}

function grass(rng: Rng, seed: number): string {
  const blades = Array.from({ length: 1100 }, () => {
    const x = rng.int(0, 900);
    const y = rng.int(0, 1230);
    const len = rng.int(40, 110);
    const bend = rng.int(-45, 45);
    const g = rng.int(90, 160);
    return `<path d="M${x} ${y} q${bend / 2} ${-len / 2} ${bend} ${-len}" stroke="rgb(${rng.int(40, 80)},${g},${rng.int(30, 60)})" stroke-width="${rng.range(2, 4.5).toFixed(1)}" fill="none" stroke-linecap="round"/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><defs>${noiseFilter("n", "0.035", 3, "0 0 0 0 0.16  0 0 0 0 0.33  0 0 0 0 0.1  0 0 0 0.8 0", seed)}</defs>` +
    `<rect width="900" height="1200" fill="#3f6b2c"/><rect width="900" height="1200" filter="url(#n)"/>${blades.join("")}</svg>`
  );
}

function wood(rng: Rng, seed: number): string {
  const planks = Array.from({ length: 6 }, (_, i) => {
    const tone = rng.int(-12, 12);
    return `<rect x="${i * 160 - 20}" y="0" width="160" height="1200" fill="rgb(${150 + tone},${100 + tone},${60 + tone})"/><line x1="${i * 160 - 20}" y1="0" x2="${i * 160 - 20}" y2="1200" stroke="#3b2414" stroke-width="4"/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><defs>` +
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.09 0.004" numOctaves="3" seed="${seed}"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0.25  0 0 0 0 0.14  0 0 0 0 0.06  0 0 0 0.75 0"/></filter></defs>` +
    `${planks.join("")}<rect width="900" height="1200" filter="url(#grain)"/></svg>`
  );
}

function backgroundSvg(design: StickerDesign, rng: Rng): string {
  switch (design.background) {
    case "pavement":
      return pavement(rng, design.seed);
    case "car":
      return car(rng, design.seed);
    case "grass":
      return grass(rng, design.seed);
    case "wood":
      return wood(rng, design.seed);
  }
}

// --- Hand -------------------------------------------------------------------------------------------------------

/** The hand holding the strip: fingers behind it and the thumb on top (from the left or right edge). */
function handSvg(side: "left" | "right", dark: boolean, top: number): { behind: string; front: string } {
  const skin = dark ? "#b98468" : "#d9a283";
  const shade = dark ? "#8a5b44" : "#b27b5f";
  const mirror = side === "right" ? `translate(900 0) scale(-1 1) ` : "";
  const svg = (id: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" style="position:absolute;left:0;top:0"><defs>` +
    `<linearGradient id="skin${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${skin}"/><stop offset="1" stop-color="${shade}"/></linearGradient>` +
    `<filter id="soft${id}"><feGaussianBlur stdDeviation="2.5"/></filter></defs><g transform="${mirror}translate(0 ${top})" filter="url(#soft${id})">${body}</g></svg>`;
  const behind = svg(
    "b",
    `<path d="M-80 -60 L140 -40 Q230 150 190 420 L-80 460 Z" fill="${shade}"/>` +
      `<rect x="-60" y="-70" width="310" height="96" rx="48" fill="url(#skinb)"/>` +
      `<rect x="-60" y="300" width="330" height="92" rx="46" fill="url(#skinb)"/>` +
      `<rect x="-60" y="396" width="290" height="88" rx="44" fill="url(#skinb)"/>`,
  );
  const front = svg(
    "f",
    `<path d="M-40 70 Q70 50 160 90 Q225 120 214 178 Q204 232 130 232 Q40 232 -40 214 Z" fill="url(#skinf)"/>` +
      `<path d="M160 108 Q196 124 198 170 Q190 202 160 206 Q180 160 160 108 Z" fill="#f2cfbf" opacity="0.6"/>`,
  );
  return { behind, front };
}

// --- Scene ------------------------------------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}

/** Torn edge of the backing strip as a polygon path. */
function tornEdge(rng: Rng, x: number, top: number, bottom: number): string {
  const points: string[] = [];
  for (let y = top; y <= bottom; y += 14) points.push(`${(x + rng.range(-9, 9)).toFixed(0)}px ${y}px`);
  return points.join(",");
}

/** Full HTML page (900×1200) of a sticker photo with the given code and handwritten time. */
export function stickerSceneHtml(design: StickerDesign, time: string = design.time): string {
  const rng = createRng(design.seed * 7919);
  const background = backgroundSvg(design, rng);
  const dark = design.background === "car";
  const leftEdge = tornEdge(rng, 12, 0, 330);
  const rightEdge = tornEdge(rng, 748, 0, 330).split(",").reverse().join(",");
  const timeSvg = handwrittenTimeSvg(time, createRng(design.seed * 104729 + Number(time.replace(":", ""))), rng.int(46, 58));
  const top = rng.int(470, 560);
  const hand = design.hand === "none" ? { behind: "", front: "" } : handSvg(design.hand, dark, top);
  const light = dark ? "radial-gradient(circle at 50% 55%, rgba(255,255,255,0.10), rgba(0,0,0,0.55) 75%)" : "radial-gradient(circle at 45% 45%, rgba(255,255,255,0.06), rgba(0,0,0,0.35) 80%)";
  const paper = dark ? "#e4e2dc" : "#f4f3ef";
  const label = dark ? "#eeede8" : "#fbfbf8";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:900px;height:1200px;overflow:hidden;background:#333}
.bg{position:absolute;inset:0;filter:blur(${dark ? 1.6 : 1.2}px)}
.strip{position:absolute;left:70px;top:${top}px;width:760px;height:330px;transform:rotate(${design.rotation}deg);filter:drop-shadow(6px 14px 14px rgba(0,0,0,0.45))}
.backing{position:absolute;inset:0;background:${paper};clip-path:polygon(${leftEdge},${rightEdge})}
.label{position:absolute;left:84px;top:22px;width:600px;height:286px;border-radius:26px;background:${label};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.07),inset 0 -8px 18px rgba(0,0,0,0.05)}
.title{position:absolute;left:0;right:0;top:44px;text-align:center;font-family:"DejaVu Serif",serif;font-size:62px;color:#262322;letter-spacing:1px;font-variant:small-caps}
.title b{font-weight:normal;font-size:78px}
.code{position:absolute;left:0;right:0;top:160px;text-align:center;font-family:"DejaVu Sans",sans-serif;font-size:92px;color:#2a2a2c;letter-spacing:3px}
.time{position:absolute;left:${rng.int(250, 330)}px;top:${rng.int(108, 124)}px;transform:rotate(${rng.int(-8, 4)}deg)}
.light{position:absolute;inset:0;background:${light};mix-blend-mode:multiply}
</style></head><body>
<div class="bg">${background}</div>
${hand.behind}
<div class="strip"><div class="backing"></div><div class="label"><div class="title"><b>J</b>otihunt 2026</div><div class="code">${escapeHtml(design.code)}</div><div class="time">${timeSvg}</div></div></div>
${hand.front}
<div class="light"></div>
</body></html>`;
}
