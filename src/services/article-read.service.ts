import mongoose from "mongoose";
import { ServiceError } from "../http/service-error";
import { Article } from "../models/article.model";
import { User } from "../models/user.model";

type Id = mongoose.Types.ObjectId | string;

/** Remember that the user opened an article */
export async function markArticleRead(userId: Id, articleId: number): Promise<void> {
  if (!(await Article.exists({ id: articleId }))) throw new ServiceError(404, "Bericht niet gevonden");
  await User.updateOne({ _id: userId }, { $addToSet: { readArticles: articleId } });
}

/** The articles this user read, and per article how many users read it */
export async function getReadState(userId: Id): Promise<{ read: number[]; readBy: Record<string, number> }> {
  const [user, counts] = await Promise.all([
    User.findById(userId, { readArticles: 1 }).lean(),
    User.aggregate<{ _id: number; count: number }>([{ $unwind: "$readArticles" }, { $group: { _id: "$readArticles", count: { $sum: 1 } } }]),
  ]);
  return { read: user?.readArticles ?? [], readBy: Object.fromEntries(counts.map((entry) => [String(entry._id), entry.count])) };
}
