import type { Rng } from "./prng";
import type { StickerDesign } from "./sticker-designs";

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

export function backgroundSvg(design: StickerDesign, rng: Rng): string {
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
