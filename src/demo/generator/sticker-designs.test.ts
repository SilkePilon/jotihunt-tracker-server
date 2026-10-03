import { describe, expect, test } from "bun:test";
import { STICKER_DESIGNS } from "./sticker-designs";
import { loadStickers } from "./sticker-photos";

describe("sticker designs", () => {
  // generate-world takes the hunt code from stickers.json while the re-rendered photos use STICKER_DESIGNS
  test("match the committed stickers.json (code, time, file order)", async () => {
    const stickers = await loadStickers();
    expect(stickers.map(({ code, time }) => ({ code, time }))).toEqual(STICKER_DESIGNS.map(({ code, time }) => ({ code, time })));
    expect(stickers.map((sticker) => sticker.file)).toEqual(STICKER_DESIGNS.map((_, index) => `sticker-${String(index + 1).padStart(2, "0")}.jpg`));
  });
});
