import { handwrittenTimeSvg } from "./handwriting";
import { createRng, type Rng } from "./prng";
import { backgroundSvg } from "./sticker-backgrounds";
import type { StickerDesign } from "./sticker-designs";

/**
 * Photo-like scenes of a Jotihunt sticker (a white label on a torn backing strip) with the case-sensitive hunt code
 * and a handwritten blue time, rendered by headless Chromium (only the DejaVu fonts are needed; the handwriting is
 * drawn as SVG strokes). Used once to make the committed stickers in src/demo/stickers/ and by the demo generator to
 * render the stickers with the hunt times of the demo world.
 */

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
