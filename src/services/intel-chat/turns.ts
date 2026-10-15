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
 * "Nieuw gesprek": stop the running turn of this chat (if any) so it never saves, wait for a save already under way, then
 * run `whileHeld` (clear the stored chat) while the chat is still taken, so no new turn can load the old history in
 * between. The chat is free again afterwards, also when `whileHeld` fails.
 */
export async function discardTurn(userId: mongoose.Types.ObjectId | string, articleId: number, whileHeld: () => Promise<void>): Promise<void> {
  const key = keyOf(userId, articleId);
  const running = turns.get(key);
  // Take the key over: the stopped turn's own endTurn is then a no-op and a new POST is 409 busy until we are done
  const hold: ActiveTurn = { key, abort: new AbortController(), discarded: true };
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
