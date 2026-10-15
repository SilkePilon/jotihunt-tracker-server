import type { UIMessage } from "ai";
import type mongoose from "mongoose";
import { IntelChat } from "../../models/intel-chat.model";

type UserId = mongoose.Types.ObjectId | string;

/** The user's chat about an item; empty when there is none */
export async function loadChat(userId: UserId, articleId: number): Promise<UIMessage[]> {
  const chat = await IntelChat.findOne({ userId, articleId }, { _id: 0, messages: 1 }).lean();
  return (chat?.messages ?? []) as UIMessage[];
}

/** Replace the stored messages (creates the chat on first save) */
export async function saveChat(userId: UserId, articleId: number, messages: UIMessage[]): Promise<void> {
  await IntelChat.updateOne({ userId, articleId }, { $set: { messages, updatedAt: new Date() } }, { upsert: true });
}

export async function clearChat(userId: UserId, articleId: number): Promise<void> {
  await IntelChat.deleteOne({ userId, articleId });
}
