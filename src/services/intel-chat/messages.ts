import type { ModelMessage, UIMessage } from "ai";
import type { FetchedImage } from "../article-media";
import { isRecord } from "../../utils/is-record";

/** Messages sent to the model per turn (the newest ones) */
export const MAX_HISTORY_TO_MODEL = 40;
/** Messages kept per conversation */
export const MAX_STORED_MESSAGES = 200;
/** User images kept (stored and sent to the model); older ones become a text note (a chat document stays far below 16 MB) */
export const MAX_USER_IMAGES = 2;
export const MAX_USER_IMAGE_BYTES = 2 * 1024 * 1024;
export const USER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_USER_TEXT = 4000;
export const DROPPED_IMAGE_TEXT = "[eerder gestuurde afbeelding, niet meer bewaard]";
/** Longer strings in stored tool outputs (a read web page) are cut to this many characters plus "…" */
export const MAX_STORED_TOOL_TEXT = 4096;
/** A stored chat stays below this JSON size (MongoDB documents max out at 16 MB); the oldest messages go first */
export const MAX_STORED_BYTES = 8 * 1024 * 1024;


/** Decoded size of base64 data */
const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/**
 * The new user message of a POST, or null when it breaks the contract: `{ id, role: 'user', parts }` with exactly one
 * non-empty text part (max 4000 chars) and at most one file part (jpeg/png/webp as a base64 data: URL, max 2 MB).
 */
export function parseIncomingMessage(value: unknown): UIMessage | null {
  if (!isRecord(value)) return null;
  const { id, role, parts } = value;
  if (typeof id !== "string" || !id || id.length > 100 || role !== "user" || !Array.isArray(parts)) return null;
  let text: string | null = null;
  let file: UIMessage["parts"][number] | null = null;
  for (const part of parts) {
    if (!isRecord(part)) return null;
    if (part.type === "text" && typeof part.text === "string" && text === null) {
      text = part.text.trim();
    } else if (part.type === "file" && file === null) {
      const mediaType = part.mediaType;
      if (typeof mediaType !== "string" || !(USER_IMAGE_TYPES as readonly string[]).includes(mediaType) || typeof part.url !== "string") return null;
      const prefix = `data:${mediaType};base64,`;
      if (!part.url.startsWith(prefix)) return null;
      const data = part.url.slice(prefix.length);
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || base64Bytes(data) > MAX_USER_IMAGE_BYTES) return null;
      const filename = typeof part.filename === "string" ? part.filename.slice(0, 200) : undefined;
      file = { type: "file", mediaType, url: part.url, ...(filename ? { filename } : {}) };
    } else {
      return null;
    }
  }
  if (!text || text.length > MAX_USER_TEXT) return null;
  return { id, role: "user", parts: file ? [{ type: "text", text }, file] : [{ type: "text", text }] };
}

/**
 * The stored history with the new message at the end. A message whose id is already there (the client's "Opnieuw"
 * after an error) replaces it and everything after it.
 */
export function appendMessage(history: UIMessage[], message: UIMessage): UIMessage[] {
  const at = history.findIndex((known) => known.id === message.id);
  return [...(at >= 0 ? history.slice(0, at) : history), message];
}

const hasContent = (message: UIMessage) => message.parts.some((part) => part.type !== "step-start");

/** A copy of a tool output with every string over MAX_STORED_TOOL_TEXT cut */
function capStrings(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STORED_TOOL_TEXT ? `${value.slice(0, MAX_STORED_TOOL_TEXT)}…` : value;
  if (Array.isArray(value)) return value.map(capStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item)]));
  return value;
}

const isToolPart = (part: UIMessage["parts"][number]) => part.type.startsWith("tool-") || part.type === "dynamic-tool";

/**
 * The conversation as it is stored and sent: the newest MAX_STORED_MESSAGES, only the newest MAX_USER_IMAGES user
 * images (older ones replaced by a text note), streaming text marked done (an aborted turn), assistant messages without
 * content dropped, long tool output strings cut; while over MAX_STORED_BYTES the oldest messages are dropped (the chat
 * then starts at a user message).
 */
export function forStorage(messages: UIMessage[]): UIMessage[] {
  let imagesLeft = MAX_USER_IMAGES;
  const kept: UIMessage[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" && !hasContent(message)) continue;
    const parts = message.parts.map((part) => {
      if (part.type === "file" && message.role === "user") {
        if (imagesLeft > 0) {
          imagesLeft--;
          return part;
        }
        return { type: "text" as const, text: DROPPED_IMAGE_TEXT };
      }
      if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") return { ...part, state: "done" as const };
      if (isToolPart(part) && "output" in part && part.output !== undefined) return { ...part, output: capStrings(part.output) } as typeof part;
      return part;
    });
    kept.push({ ...message, parts });
    if (kept.length >= MAX_STORED_MESSAGES) break;
  }
  return withinByteBudget(kept.reverse());
}

/** Drop the oldest messages while the chat is over MAX_STORED_BYTES, then up to the next user message; the newest message always stays */
function withinByteBudget(messages: UIMessage[]): UIMessage[] {
  const sizes = messages.map((message) => Buffer.byteLength(JSON.stringify(message)));
  // The array's brackets and commas
  let total = sizes.reduce((sum, size) => sum + size + 1, 1);
  if (total <= MAX_STORED_BYTES) return messages;
  let start = 0;
  while (total > MAX_STORED_BYTES && start < messages.length - 1) total -= sizes[start++] + 1;
  while (start < messages.length - 1 && messages[start].role !== "user") start++;
  return messages.slice(start);
}

/**
 * The messages without `null` part fields (chats stored before saveChat dropped `undefined`: BSON made those `null`, which
 * the model message schema rejects). Only the parts' own fields: tool input/output keep their nulls.
 */
export function withoutNullPartFields(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => Object.fromEntries(Object.entries(part).filter(([, value]) => value !== null)) as typeof part),
  }));
}

/** The newest MAX_HISTORY_TO_MODEL messages, starting at a user message */
export function modelWindow(messages: UIMessage[]): UIMessage[] {
  const window = messages.slice(-MAX_HISTORY_TO_MODEL);
  const firstUser = window.findIndex((message) => message.role === "user");
  return firstUser < 0 ? window : window.slice(firstUser);
}

/**
 * Attach the item's own images to the first user message sent to the model (once per turn, so the model always sees
 * them however long the chat is).
 */
export function withItemImages(messages: ModelMessage[], images: FetchedImage[]): ModelMessage[] {
  if (images.length === 0) return messages;
  const at = messages.findIndex((message) => message.role === "user");
  if (at < 0) return messages;
  const first = messages[at];
  if (first.role !== "user") return messages;
  const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  const attached = [
    { type: "text" as const, text: `Afbeeldingen van het open item: ${images.map((image) => image.name).join(", ")}` },
    ...images.map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mediaType, filename: image.name })),
  ];
  return [...messages.slice(0, at), { ...first, content: [...attached, ...content] }, ...messages.slice(at + 1)];
}
