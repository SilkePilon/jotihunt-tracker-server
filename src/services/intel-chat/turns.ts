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
}

const turns = new Map<string, ActiveTurn>();

const keyOf = (userId: mongoose.Types.ObjectId | string, articleId: number) => `${userId.toString()}:${articleId}`;

/** Register a new turn of the user's chat about an item; null while another turn of that chat runs */
export function startTurn(userId: mongoose.Types.ObjectId | string, articleId: number): ActiveTurn | null {
  const key = keyOf(userId, articleId);
  if (turns.has(key)) return null;
  const turn: ActiveTurn = { key, abort: new AbortController(), discarded: false };
  turns.set(key, turn);
  return turn;
}

/** The turn is over (saved, skipped or failed before streaming) */
export function endTurn(turn: ActiveTurn) {
  if (turns.get(turn.key) === turn) turns.delete(turn.key);
}

/**
 * "Nieuw gesprek": stop the running turn of this chat (if any) so it never saves, wait for a save already under way and
 * free the chat for a new turn. Call before deleting the stored chat.
 */
export async function discardTurn(userId: mongoose.Types.ObjectId | string, articleId: number): Promise<void> {
  const turn = turns.get(keyOf(userId, articleId));
  if (!turn) return;
  turn.discarded = true;
  turn.abort.abort();
  await turn.saving?.catch(() => undefined);
  endTurn(turn);
}
