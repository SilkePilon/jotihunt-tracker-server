/** Sticker photo designs: the committed hunt codes and times (must match src/demo/stickers/stickers.json) and how each photo looks. */

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
