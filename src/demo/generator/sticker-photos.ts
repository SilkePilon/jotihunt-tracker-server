import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "puppeteer";
import { STICKER_DESIGNS, STICKER_HEIGHT, STICKER_WIDTH } from "./sticker-designs";
import { stickerSceneHtml } from "./sticker-scene";

export interface StickerInfo {
  file: string;
  code: string;
  /** "HH:MM" written on the committed photo */
  time: string;
}

const STICKER_DIR = path.join(import.meta.dir, "..", "stickers");
const RENDER_TIMEOUT_MS = 20_000;

/** The committed sticker photos (src/demo/stickers/stickers.json). */
export async function loadStickers(): Promise<StickerInfo[]> {
  return JSON.parse(await readFile(path.join(STICKER_DIR, "stickers.json"), "utf8")) as StickerInfo[];
}

export async function readStickerPhoto(file: string): Promise<Buffer> {
  return readFile(path.join(STICKER_DIR, path.basename(file)));
}

/** "HH:MM" of a time as the fox writes it (Dutch local time). */
export function localClock(time: Date): string {
  return new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hour12: false }).format(time);
}

/**
 * Render the stickers again with the hunt times of the demo world (headless Chromium, as in the Docker image), so the
 * handwritten time on the photo matches the report. Resolves null when Chromium is not available (then the committed
 * photos are used as they are).
 */
export async function renderStickerPhotos(items: { sticker: number; time: string }[]): Promise<Buffer[] | null> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let browser: Browser;
  try {
    const { default: puppeteer } = await import("puppeteer");
    browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  } catch {
    return null;
  }
  try {
    const render = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: STICKER_WIDTH, height: STICKER_HEIGHT });
      const photos: Buffer[] = [];
      for (const item of items) {
        await page.setContent(stickerSceneHtml(STICKER_DESIGNS[item.sticker % STICKER_DESIGNS.length], item.time), { waitUntil: "load" });
        photos.push(Buffer.from(await page.screenshot({ type: "jpeg", quality: 80 })));
      }
      return photos;
    };
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), RENDER_TIMEOUT_MS);
    });
    return await Promise.race([render(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}
