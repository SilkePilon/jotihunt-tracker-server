import { MB } from "./http-limits";
import { parseStickerReading, type StickerReading } from "./sticker-ocr.helpers";

export interface GeminiRequestConfig {
  headers: Record<string, string>;
  /** Idle timeout (axios) */
  timeout: number;
  /** Total deadline: under Bun axios' timeout is idle-only, a trickling answer would never end */
  signal: AbortSignal;
  maxContentLength: number;
  maxBodyLength: number;
}

/** The part of axios the client needs; injected so tests never call the real API. */
export interface GeminiHttp {
  post<T>(url: string, body: unknown, config: GeminiRequestConfig): Promise<{ data: T }>;
}

/** The answer is a small JSON text; the request carries one photo (at most 5 MB, about 7 MB as base64) */
const MAX_RESPONSE_BYTES = 5 * MB;
const MAX_REQUEST_BYTES = 20 * MB;

/** Failure of a Gemini call. The (Dutch) message is shown to HQ; it never contains the API key or the raw HTTP error. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export interface StickerReader {
  readSticker(base64: string, mimeType: string): Promise<StickerReading>;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
/** Total time for one sticker reading (a flash model answers in seconds) */
const TIMEOUT_MS = 30_000;

export const STICKER_PROMPT = `The photo shows a Jotihunt sticker (a scouting game). Read three things from it.

1. The hunt code. The sticker has a printed title "JOTIHUNT <year>" (for example "JOTIHUNT 2026"). Below the title the hunt code is printed: 4 to 12 letters and/or digits, no spaces. The code is case-sensitive: copy every letter exactly as printed, keeping uppercase and lowercase apart (e.g. "GNcrZRZ" is not "GNCRZRZ"), and take care to distinguish look-alikes such as O/0, I/l/1, S/5, Z/2, B/8. The code is never the title "JOTIHUNT" and never the year.

2. The handwritten time. Someone wrote the time of the hunt on the sticker by hand with a pen (often blue ink); the writing may overlap the printed text. It is a 24-hour time written as H:MM or HH:MM; the separator may be ":", ".", ";" or ",". Return it as "HH:MM".

3. Where the sticker is. The bounding box of the whole sticker (the label itself, not the tree, pole or hand around it) as [ymin, xmin, ymax, xmax], integers normalised to 0-1000 relative to the image.

Answer with only this JSON object and nothing else:
{"code": string or null, "codeConfidence": number from 0 to 1, "time": "HH:MM" or null, "timeConfidence": number from 0 to 1, "box": [ymin, xmin, ymax, xmax] or null}
Use null (with confidence 0) for a value you cannot read, and null for box when no sticker is visible. The confidence is how sure you are that the value is exactly right.`;

type GenerateContentResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

/** One generateContent call with a JSON answer. Returns the answer text; throws GeminiError (never with the key). */
export async function generateJson({
  http,
  apiKey,
  model,
  parts,
  generationConfig = {},
  timeoutMs,
}: {
  http: GeminiHttp;
  apiKey: string;
  model: string;
  parts: unknown[];
  generationConfig?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = { contents: [{ parts }], generationConfig: { responseMimeType: "application/json", ...generationConfig } };
  let response: { data: GenerateContentResponse };
  try {
    response = await http.post<GenerateContentResponse>(url, body, {
      headers: { "x-goog-api-key": apiKey },
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_REQUEST_BYTES,
    });
  } catch (error) {
    // Only the status code is used: the error object holds the request headers (with the key).
    // A 2xx status means the answer broke off while its body was read (timeout, connection lost): retryable like no answer.
    const received = (error as { response?: { status?: number } } | null)?.response?.status;
    const status = received !== undefined && received >= 300 ? received : undefined;
    throw new GeminiError(status ? `Gemini-verzoek mislukt (HTTP ${status})` : "Gemini niet bereikbaar", !status || status === 429 || status >= 500, status);
  }
  return response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

export function createGeminiClient({ apiKey, model, http }: { apiKey: string; model: string; http: GeminiHttp }): StickerReader {
  return {
    async readSticker(base64: string, mimeType: string): Promise<StickerReading> {
      const text = await generateJson({
        http,
        apiKey,
        model,
        parts: [{ text: STICKER_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }],
        generationConfig: { temperature: 0 },
        timeoutMs: TIMEOUT_MS,
      });
      try {
        return parseStickerReading(text);
      } catch {
        throw new GeminiError("Gemini gaf geen geldig antwoord", false);
      }
    },
  };
}
