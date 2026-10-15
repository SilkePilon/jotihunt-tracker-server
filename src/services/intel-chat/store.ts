import type { UIMessage } from "ai";
import type mongoose from "mongoose";
import { IntelChat } from "../../models/intel-chat.model";

type UserId = mongoose.Types.ObjectId | string;

/** The user's chat about an item; empty when there is none */
export async function loadChat(userId: UserId, articleId: number): Promise<UIMessage[]> {
  const chat = await IntelChat.findOne({ userId, articleId }, { _id: 0, messages: 1 }).lean();
  return (chat?.messages ?? []) as UIMessage[];
}

/**
 * Replace the stored messages (creates the chat on first save). Stored as their JSON form: BSON would keep the SDK's
 * `undefined` part fields as `null`, which the model message schema rejects on the next turn.
 */
export async function saveChat(userId: UserId, articleId: number, messages: UIMessage[]): Promise<void> {
  const stored = JSON.parse(JSON.stringify(messages)) as UIMessage[];
  await IntelChat.updateOne({ userId, articleId }, { $set: { messages: stored, updatedAt: new Date() } }, { upsert: true });
}

export async function clearChat(userId: UserId, articleId: number): Promise<void> {
  await IntelChat.deleteOne({ userId, articleId });
}
