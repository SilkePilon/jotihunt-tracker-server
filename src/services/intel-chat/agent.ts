import { convertToModelMessages, generateId, isStepCount, streamText, toUIMessageStream, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { toGeminiError } from "../ai/gemini-error";
import type { ArticleImage, FetchedImage } from "../article-media";
import { loadItemImages } from "./item-images";
import { modelWindow, withItemImages, withoutNullPartFields } from "./messages";
import { buildSystemPrompt } from "./prompt";
import type { ItemView } from "./tools/app-data";
import { activeToolNames, createIntelTools, type IntelToolContext } from "./tools";

/** The models of the chat: normal turns, "Denk diep" turns, and the web/code sub-calls */
export interface IntelChatModels {
  chat: LanguageModel;
  deep: LanguageModel;
  tool: LanguageModel;
}

/** Model steps per turn (each tool round is a step) */
export const MAX_STEPS = 12;
/** Total time of one turn, all steps and tools included */
export const TURN_TIMEOUT_MS = 150_000;
export const DEEP_TURN_TIMEOUT_MS = 300_000;

export interface IntelChatTurn {
  models: IntelChatModels;
  item: ItemView;
  article: { id: number; content: string; contentHash?: string | null };
  /** Stored history + the new user message (see forStorage); also the stream's originalMessages */
  conversation: UIMessage[];
  web: boolean;
  deep: boolean;
  now: Date;
  /** Aborts the turn (client gone) */
  abortSignal: AbortSignal;
  /** Called once with every message when the stream ends (finished, failed or aborted) */
  onEnd: (messages: UIMessage[]) => Promise<void> | void;
  /** Tools: walkMinutes, fetch, lookup (tests and instance wiring) */
  toolContext?: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">>;
  /** Tests: the item image download */
  downloadImages?: (images: ArticleImage[]) => Promise<FetchedImage[]>;
}

/**
 * One chat turn: the model (deep → pro model with high thinking) streams an answer, calling our tools (web tools only
 * with `web`), at most MAX_STEPS steps. Returns the UI message stream for pipeUIMessageStreamToResponse.
 */
export async function streamIntelChat(turn: IntelChatTurn): Promise<ReadableStream<UIMessageChunk>> {
  const tools = createIntelTools({ articleId: turn.item.articleId, now: () => turn.now, toolModel: turn.models.tool, ...turn.toolContext });
  const images = await loadItemImages(turn.article, turn.downloadImages);
  const messages = withItemImages(await convertToModelMessages(withoutNullPartFields(modelWindow(turn.conversation)), { tools, ignoreIncompleteToolCalls: true }), images);
  const result = streamText({
    model: turn.deep ? turn.models.deep : turn.models.chat,
    instructions: buildSystemPrompt({ item: turn.item, now: turn.now, web: turn.web, attachedImages: images.map((image) => image.name) }),
    messages,
    tools,
    activeTools: activeToolNames(tools, turn.web),
    stopWhen: isStepCount(MAX_STEPS),
    providerOptions: turn.deep ? { google: { thinkingConfig: { thinkingLevel: "high" } } } : undefined,
    maxRetries: 1,
    abortSignal: AbortSignal.any([turn.abortSignal, AbortSignal.timeout(turn.deep ? DEEP_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS)]),
  });
  return toUIMessageStream({
    stream: result.stream,
    tools,
    originalMessages: turn.conversation,
    generateMessageId: generateId,
    sendReasoning: false,
    sendSources: false,
    // Only our own Dutch message: a raw API error holds the request (with the key)
    onError: (error) => toGeminiError(error).message,
    onEnd: async ({ messages: all }) => {
      await turn.onEnd(all);
    },
  });
}
