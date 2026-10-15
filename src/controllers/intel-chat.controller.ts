import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Request, Response } from "express";
import { currentGeneration } from "../demo/demo-mode";
import { logger } from "../logger";
import { streamIntelChat } from "../services/intel-chat/agent";
import { getIntelChatModels, getIntelToolDeps } from "../services/intel-chat/instance";
import { appendMessage, forStorage, parseIncomingMessage } from "../services/intel-chat/messages";
import { clearChat, loadChat, saveChat } from "../services/intel-chat/store";
import { findPublicArticle, loadItemView } from "../services/intel-chat/tools/app-data";

const articleIdOf = (req: Request) => Number(req.params.articleId);
const notFound = (res: Response) => res.status(404).json({ error: "not_found" });
const aiUnavailable = (res: Response) => res.status(503).json({ error: "ai_unavailable" });

/** GET /intel-chat/:articleId → { messages } */
export async function getChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  if (!getIntelChatModels()) return aiUnavailable(res);
  return res.status(200).json({ messages: await loadChat(req.user!._id, articleId) });
}

/** DELETE /intel-chat/:articleId → 204 ("Nieuw gesprek") */
export async function deleteChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  await clearChat(req.user!._id, articleId);
  return res.status(204).end();
}

/**
 * POST /intel-chat/:articleId { message, web, deep } → UI message stream. The stored history plus the new message go to
 * the model; when the stream ends (also after an abort or error) everything produced is saved, unless the database
 * was switched (demo) meanwhile.
 */
export async function postChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  const article = await findPublicArticle(articleId);
  if (!article) return notFound(res);
  const models = getIntelChatModels();
  if (!models) return aiUnavailable(res);
  const message = parseIncomingMessage(req.body?.message);
  if (!message) return res.status(400).json({ error: "invalid_message" });

  const userId = req.user!._id;
  const item = await loadItemView(articleId);
  if (!item) return notFound(res);
  const conversation = forStorage(appendMessage(await loadChat(userId, articleId), message));
  const generation = currentGeneration();
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const stream = await streamIntelChat({
    models,
    item,
    article,
    conversation,
    web: req.body.web === true,
    deep: req.body.deep === true,
    now: new Date(),
    abortSignal: abort.signal,
    toolContext: getIntelToolDeps(),
    onEnd: async (messages: UIMessage[]) => {
      if (currentGeneration() !== generation) return;
      try {
        await saveChat(userId, articleId, forStorage(messages));
      } catch (error) {
        logger.error(`Could not save the intel chat of item ${articleId}`, error);
      }
    },
  });
  await pipeUIMessageStreamToResponse({ response: res, stream });
}
