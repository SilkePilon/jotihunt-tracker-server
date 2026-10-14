import mongoose from "mongoose";
import { ServiceError } from "../http/service-error";
import { Article, publicArticlesFilter } from "../models/article.model";
import { User } from "../models/user.model";

type Id = mongoose.Types.ObjectId | string;

/** Remember that the user opened an article (one of the articles users can see) */
export async function markArticleRead(userId: Id, articleId: number): Promise<void> {
  // $and: the public filter is a condition on `id` too, so spreading it would replace the id itself
  if (!(await Article.exists({ $and: [{ id: articleId }, publicArticlesFilter()] }))) throw new ServiceError(404, "Bericht niet gevonden");
  await User.updateOne({ _id: userId }, { $addToSet: { readArticles: articleId } });
}

/** The articles this user read, and per article the names of the users who read it (sorted) */
export async function getReadState(userId: Id): Promise<{ read: number[]; readBy: Record<string, string[]> }> {
  const [user, readers] = await Promise.all([
    User.findById(userId, { readArticles: 1 }).lean(),
    User.find({ "readArticles.0": { $exists: true } }, { name: 1, readArticles: 1 }).sort({ name: 1 }).lean(),
  ]);
  const readBy: Record<string, string[]> = {};
  for (const reader of readers) for (const articleId of reader.readArticles ?? []) (readBy[String(articleId)] ??= []).push(reader.name);
  return { read: user?.readArticles ?? [], readBy };
}
