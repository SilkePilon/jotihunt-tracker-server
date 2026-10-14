import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import { getReadState, markArticleRead } from "./article-read.service";

const makeUser = (name: string) => User.create({ name });
const makeArticle = (id: number) => Article.create({ id, title: `Nieuws ${id}`, type: "news", publishAt: new Date("2026-10-17T12:00:00Z"), content: "x" });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("article read state", () => {
  test("marking twice stores the id once", async () => {
    const [user] = await Promise.all([makeUser("sanne"), makeArticle(3)]);
    await markArticleRead(user._id, 3);
    await markArticleRead(user._id, 3);
    expect((await User.findById(user._id).lean())?.readArticles).toEqual([3]);
  });

  test("404 for an unknown article", async () => {
    const user = await makeUser("sanne");
    const error = (await markArticleRead(user._id, 99).catch((caught: unknown) => caught)) as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(404);
  });

  test("404 for a seeded test article (never shown to users)", async () => {
    const [user] = await Promise.all([makeUser("sanne"), makeArticle(900001), makeArticle(3)]);
    const error = (await markArticleRead(user._id, 900001).catch((caught: unknown) => caught)) as ServiceError;
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(404);
    expect((await User.findById(user._id).lean())?.readArticles).toEqual([]);
  });

  test("getReadState returns the user's own ids and the names of the users who read each article", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeArticle(3), makeArticle(4)]);
    await markArticleRead(a._id, 3);
    await markArticleRead(a._id, 4);
    await markArticleRead(b._id, 3);
    const state = await getReadState(b._id);
    expect(state.read).toEqual([3]);
    expect(state.readBy).toEqual({ "3": ["daan", "sanne"], "4": ["sanne"] });
  });

  test("a user who read nothing gets empty state", async () => {
    const user = await makeUser("sanne");
    expect(await getReadState(user._id)).toEqual({ read: [], readBy: {} });
  });
});
