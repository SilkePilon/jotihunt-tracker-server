import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { GeminiError, toGeminiError } from "./ai/gemini-error";
import { parseStickerReading, type StickerReading } from "./sticker-ocr.helpers";

export { GeminiError };

export interface StickerReader {
  readSticker(base64: string, mimeType: string): Promise<StickerReading>;
}

/** Total time for one sticker reading (a flash model answers in seconds) */
export const STICKER_TIMEOUT_MS = 30_000;

export const STICKER_PROMPT = `The photo shows a Jotihunt sticker (a scouting game). Read three things from it.

1. The hunt code. The sticker has a printed title "JOTIHUNT <year>" (for example "JOTIHUNT 2026"). Below the title the hunt code is printed: 4 to 12 letters and/or digits, no spaces. The code is case-sensitive: copy every letter exactly as printed, keeping uppercase and lowercase apart (e.g. "GNcrZRZ" is not "GNCRZRZ"), and take care to distinguish look-alikes such as O/0, I/l/1, S/5, Z/2, B/8. The code is never the title "JOTIHUNT" and never the year.

2. The handwritten time. Someone wrote the time of the hunt on the sticker by hand with a pen (often blue ink); the writing may overlap the printed text. It is a 24-hour time written as H:MM or HH:MM; the separator may be ":", ".", ";" or ",". Return it as "HH:MM".

3. Where the sticker is. The bounding box of the whole sticker (the label itself, not the tree, pole or hand around it) as [ymin, xmin, ymax, xmax], integers normalised to 0-1000 relative to the image.

Answer with only this JSON object and nothing else:
{"code": string or null, "codeConfidence": number from 0 to 1, "time": "HH:MM" or null, "timeConfidence": number from 0 to 1, "box": [ymin, xmin, ymax, xmax] or null}
Use null (with confidence 0) for a value you cannot read, and null for box when no sticker is visible. The confidence is how sure you are that the value is exactly right.`;

/** Reads hunt stickers with one Gemini call per photo. Throws GeminiError (never with the key); retrying is the caller's job. */
export function createGeminiClient({ model, timeoutMs = STICKER_TIMEOUT_MS }: { model: LanguageModel; timeoutMs?: number }): StickerReader {
  return {
    async readSticker(base64: string, mimeType: string): Promise<StickerReading> {
      let text: string;
      try {
        const result = await generateText({
          model,
          output: Output.json(),
          temperature: 0,
          maxRetries: 0,
          timeout: timeoutMs,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: STICKER_PROMPT },
                { type: "file", mediaType: mimeType, data: base64 },
              ],
            },
          ],
        });
        text = result.text;
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error) || typeof error.text !== "string") throw toGeminiError(error);
        text = error.text;
      }
      // Our lenient parser decides, also for text the SDK's strict JSON parse rejected (such as a fenced answer):
      // it strips fences and turns invalid parts into null instead of failing the reading
      try {
        return parseStickerReading(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
