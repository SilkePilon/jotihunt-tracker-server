import type { UIMessage, UIMessageChunk } from "ai";
import type mongoose from "mongoose";

/** A chat turn that is running (streaming, or saving what it produced) */
export interface ActiveTurn {
  readonly key: string;
  /** Stops the turn's model call and tools */
  readonly abort: AbortController;
  /** Set by "Nieuw gesprek": the turn must not save anymore */
  discarded: boolean;
  /** The save of the turn's messages, once it started */
  saving?: Promise<void>;
  /** Stored history + the turn's user message, once loaded (GET shows it while the answer is not saved yet) */
  conversation?: UIMessage[];
  /** Every chunk streamed so far: a client that (re)connects gets them all, then follows live */
  readonly chunks: UIMessageChunk[];
  /** Set when the model stream ended (finished, failed or stopped); no chunks follow */
  streamDone: boolean;
  readonly listeners: Set<() => void>;
}

const turns = new Map<string, ActiveTurn>();

const keyOf = (userId: mongoose.Types.ObjectId | string, articleId: number) => `${userId.toString()}:${articleId}`;

const newTurn = (key: string, discarded: boolean): ActiveTurn => ({ key, abort: new AbortController(), discarded, chunks: [], streamDone: false, listeners: new Set() });

/** Register a new turn of the user's chat about an item; null while another turn of that chat runs */
export function startTurn(userId: mongoose.Types.ObjectId | string, articleId: number): ActiveTurn | null {
  const key = keyOf(userId, articleId);
  if (turns.has(key)) return null;
  const turn = newTurn(key, false);
  turns.set(key, turn);
  return turn;
}

/** The running turn of a chat, if any (also while it is saving) */
export function findTurn(userId: mongoose.Types.ObjectId | string, articleId: number): ActiveTurn | undefined {
  return turns.get(keyOf(userId, articleId));
}

/** The turn is over (saved, skipped or failed before streaming) */
export function endTurn(turn: ActiveTurn) {
  if (turns.get(turn.key) === turn) turns.delete(turn.key);
}

/**
 * Read the turn's model stream to its end on the server, whether or not a client listens: closing the chat (or the
 * page) does not stop the turn, only `abort` does. Every chunk is kept for followTurn.
 */
export async function runTurnStream(turn: ActiveTurn, stream: ReadableStream<UIMessageChunk>): Promise<void> {
  const notify = () => {
    for (const listener of turn.listeners) listener();
  };
  try {
    for await (const chunk of stream) {
      turn.chunks.push(chunk);
      notify();
    }
  } finally {
    turn.streamDone = true;
    notify();
  }
}

/** The turn's stream from its first chunk, then live until it ends; `signal` (client gone) stops only this copy */
export function followTurn(turn: ActiveTurn, signal: AbortSignal): ReadableStream<UIMessageChunk> {
  let sent = 0;
  let listener: (() => void) | undefined;
  const detach = () => {
    if (listener) turn.listeners.delete(listener);
    signal.removeEventListener("abort", onAbort);
  };
  let close: () => void = () => undefined;
  const onAbort = () => close();
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      let closed = false;
      close = () => {
        if (closed) return;
        closed = true;
        detach();
        controller.close();
      };
      listener = () => {
        if (closed) return;
        while (sent < turn.chunks.length) controller.enqueue(turn.chunks[sent++]);
        if (turn.streamDone) close();
      };
      turn.listeners.add(listener);
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) return close();
      listener();
    },
    cancel() {
      detach();
    },
  });
}

/**
 * "Nieuw gesprek": stop the running turn of this chat (if any) so it never saves, wait for a save already under way, then
 * run `whileHeld` (clear the stored chat) while the chat is still taken, so no new turn can load the old history in
 * between. The chat is free again afterwards, also when `whileHeld` fails.
 */
export async function discardTurn(userId: mongoose.Types.ObjectId | string, articleId: number, whileHeld: () => Promise<void>): Promise<void> {
  const key = keyOf(userId, articleId);
  const running = turns.get(key);
  // Take the key over: the stopped turn's own endTurn is then a no-op and a new POST is 409 busy until we are done
  const hold = newTurn(key, true);
  turns.set(key, hold);
  try {
    if (running) {
      running.discarded = true;
      running.abort.abort();
      await running.saving?.catch(() => undefined);
    }
    await whileHeld();
  } finally {
    endTurn(hold);
  }
}
