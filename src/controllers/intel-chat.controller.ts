import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Request, Response } from "express";
import { releaseDemoWork } from "../demo/database-switch";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { logger } from "../logger";
import { streamIntelChat } from "../services/intel-chat/agent";
import { getIntelChatModels, getIntelToolDeps } from "../services/intel-chat/instance";
import { appendMessage, forStorage, parseIncomingMessage } from "../services/intel-chat/messages";
import { clearChat, loadChat, saveChat } from "../services/intel-chat/store";
import { findPublicArticle, loadItemView } from "../services/intel-chat/tools/app-data";
import { discardTurn, endTurn, startTurn, type ActiveTurn } from "../services/intel-chat/turns";

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

/** DELETE /intel-chat/:articleId → 204 ("Nieuw gesprek"); a running turn is stopped and never saved */
export async function deleteChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  // The chat stays taken until it is cleared: a question meanwhile is 409 busy instead of reviving the old history
  await discardTurn(req.user!._id, articleId, () => clearChat(req.user!._id, articleId));
  return res.status(204).end();
}

/**
 * POST /intel-chat/:articleId { message, web, deep } → UI message stream. The stored history plus the new message go to
 * the model; when the stream ends (also after an abort or error) everything produced is saved, unless the chat was
 * cleared ("Nieuw gesprek") or the database was switched (demo) meanwhile. One turn per chat at a time (409 busy).
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
  const turn = startTurn(userId, articleId);
  if (!turn) return res.status(409).json({ error: "busy" });
  res.on("close", () => {
    if (!res.writableFinished) turn.abort.abort();
  });
  let streaming = false;
  try {
    const item = await loadItemView(articleId);
    if (!item) return notFound(res);
    const conversation = forStorage(appendMessage(await loadChat(userId, articleId), message));
    const generation = currentGeneration();

    const stream = await streamIntelChat({
      models,
      item,
      article,
      conversation,
      web: req.body.web === true,
      deep: req.body.deep === true,
      now: new Date(),
      abortSignal: turn.abort.signal,
      toolContext: getIntelToolDeps(),
      onEnd: (messages: UIMessage[]) => {
        // No await before `saving` is set: "Nieuw gesprek" either sees the save or the save sees `discarded`
        if (turn.discarded) return endTurn(turn);
        turn.saving = saveTurn(turn, userId, articleId, generation, messages);
        return turn.saving;
      },
    });
    streaming = true;
    // A turn may stream for minutes: it must not hold up a demo switch (its save is counted and generation-checked)
    releaseDemoWork(res);
    await pipeUIMessageStreamToResponse({ response: res, stream });
  } catch (error) {
    // Only the name: the error may hold the prompt
    logger.error(`Intel chat turn of item ${articleId} failed${streaming ? "" : " before streaming"}: ${error instanceof Error ? error.name : "unknown error"}`);
    if (!res.headersSent) res.status(500).json({ error: "chat_failed" });
    if (streaming) {
      // The stream may never be read to its end (so no onEnd): stop the turn and free the chat (no-op when onEnd already did)
      turn.abort.abort();
      endTurn(turn);
    }
  } finally {
    // Once streaming, the stream's onEnd ends the turn
    if (!streaming) endTurn(turn);
  }
}

/**
 * Save what a turn produced, unless a demo switch is running or the database was switched since the turn started;
 * counted so a switch waits for it
 */
async function saveTurn(turn: ActiveTurn, userId: Parameters<typeof saveChat>[0], articleId: number, generation: number, messages: UIMessage[]) {
  try {
    await runTracked(() => saveChat(userId, articleId, forStorage(messages)), { generation });
  } catch (error) {
    logger.error(`Could not save the intel chat of item ${articleId}`, error);
  } finally {
    endTurn(turn);
  }
}
