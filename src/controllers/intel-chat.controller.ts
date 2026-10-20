import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Request, Response } from "express";
import { releaseSwitchWork } from "../editions/database-switch";
import { currentGeneration, runTracked } from "../editions/work-tracking";
import { logger } from "../logger";
import { streamIntelChat } from "../services/intel-chat/agent";
import { getIntelChatModels, getIntelToolDeps } from "../services/intel-chat/instance";
import { appendMessage, forStorage, parseIncomingMessage } from "../services/intel-chat/messages";
import { clearChat, loadChat, saveChat } from "../services/intel-chat/store";
import { findPublicArticle, loadItemView } from "../services/intel-chat/tools/app-data";
import { discardTurn, endTurn, findTurn, followTurn, runTurnStream, startTurn, type ActiveTurn } from "../services/intel-chat/turns";

const articleIdOf = (req: Request) => Number(req.params.articleId);
const notFound = (res: Response) => res.status(404).json({ error: "not_found" });
const aiUnavailable = (res: Response) => res.status(503).json({ error: "ai_unavailable" });

/** A turn whose answer can still be followed: streaming or saving, and not stopped by "Nieuw gesprek" */
function followableTurn(req: Request, articleId: number) {
  const turn = findTurn(req.user!._id, articleId);
  return turn && !turn.discarded && turn.conversation ? turn : undefined;
}

/**
 * GET /intel-chat/:articleId → { messages, running }. While a turn runs (also after its client left) the messages end
 * with its question and `running` is true: GET /:articleId/stream then gives its answer.
 */
export async function getChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  if (!getIntelChatModels()) return aiUnavailable(res);
  const turn = followableTurn(req, articleId);
  if (turn) return res.status(200).json({ messages: turn.conversation, running: true });
  return res.status(200).json({ messages: await loadChat(req.user!._id, articleId), running: false });
}

/** GET /intel-chat/:articleId/stream → the running turn's UI message stream from its start, or 204 when none runs */
export async function resumeChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  const turn = followableTurn(req, articleId);
  if (!turn) return res.status(204).end();
  const gone = new AbortController();
  res.on("close", () => gone.abort());
  // Following a turn is not demo work: the turn itself is
  releaseSwitchWork(res);
  await pipeUIMessageStreamToResponse({ response: res, stream: followTurn(turn, gone.signal) });
}

/** POST /intel-chat/:articleId/stop → 204: the Stop button. The turn saves what it produced so far */
export async function stopChat(req: Request, res: Response) {
  const articleId = articleIdOf(req);
  if (!(await findPublicArticle(articleId))) return notFound(res);
  followableTurn(req, articleId)?.abort.abort();
  return res.status(204).end();
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
 * the model; when the stream ends (also after a stop or error) everything produced is saved, unless the chat was
 * cleared ("Nieuw gesprek") or the database was switched (demo) meanwhile. One turn per chat at a time (409 busy).
 * The turn runs on when the client leaves (closed chat or page); only POST /stop or "Nieuw gesprek" stop it.
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
  const gone = new AbortController();
  res.on("close", () => gone.abort());
  let streaming = false;
  try {
    const item = await loadItemView(articleId);
    if (!item) return notFound(res);
    const conversation = forStorage(appendMessage(await loadChat(userId, articleId), message));
    turn.conversation = conversation;
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
    releaseSwitchWork(res);
    // Read on the server to the end (onEnd then saves and ends the turn); this client follows while it is connected
    runTurnStream(turn, stream).catch((error) => {
      logger.error(`Intel chat turn of item ${articleId} failed: ${error instanceof Error ? error.name : "unknown error"}`);
      turn.discarded = true;
      turn.abort.abort();
      endTurn(turn);
    });
    await pipeUIMessageStreamToResponse({ response: res, stream: followTurn(turn, gone.signal) });
  } catch (error) {
    // Only the name: the error may hold the prompt
    const name = error instanceof Error ? error.name : "unknown error";
    // Once streaming only this client's copy failed: the turn runs on (runTurnStream)
    if (streaming) logger.warn(`Intel chat answer of item ${articleId} could not be sent: ${name}`);
    else logger.error(`Intel chat turn of item ${articleId} failed before streaming: ${name}`);
    if (!res.headersSent) res.status(500).json({ error: "chat_failed" });
  } finally {
    // Once streaming, the stream's onEnd (or runTurnStream's failure) ends the turn
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
