import { convertToModelMessages, generateId, streamText, toUIMessageStream, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { logger } from "../../logger";
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
 * One chat turn: the model (deep → pro model with high thinking) streams its thought summaries (reasoning parts, stored
 * with the message and sent back to Gemini next turn as signed thoughts) and an answer, calling our tools (web tools only
 * with `web`), as many steps and as long as it needs: only the user stops a turn (Stop, "Nieuw gesprek"). Returns the UI message stream for pipeUIMessageStreamToResponse.
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
    // No step limit: the model ends the turn by answering without a tool call
    stopWhen: () => false,
    // Thought summaries in both modes (streamed as reasoning); normal turns keep the model's default thinking level
    providerOptions: { google: { thinkingConfig: turn.deep ? { thinkingLevel: "high", includeThoughts: true } : { includeThoughts: true } } },
    maxRetries: 1,
    abortSignal: turn.abortSignal,
    // Never the raw error (the SDK default prints it, request body with prompt and images included)
    onError: ({ error }) => logger.warn(`Intel chat turn failed: ${toGeminiError(error).message}`),
  });
  return toUIMessageStream({
    stream: result.stream,
    tools,
    originalMessages: turn.conversation,
    generateMessageId: generateId,
    sendReasoning: true,
    sendSources: false,
    // Only our own Dutch message: a raw API error holds the request (with the key)
    onError: (error) => toGeminiError(error).message,
    onEnd: async ({ messages: all }) => {
      await turn.onEnd(all);
    },
  });
}
