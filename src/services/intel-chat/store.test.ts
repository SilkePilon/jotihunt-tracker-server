import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import mongoose from "mongoose";
import { IntelChat } from "../../models/intel-chat.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { clearChat, loadChat, saveChat } from "./store";

const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("intel chat store", () => {
  test("empty until saved; saved per user and item; replaced on the next save", async () => {
    expect(await loadChat(alice, 1)).toEqual([]);
    await saveChat(alice, 1, [message("m1", "hoi")]);
    await saveChat(bob, 1, [message("b1", "andere gebruiker")]);
    await saveChat(alice, 2, [message("m2", "ander item")]);
    expect(await loadChat(alice, 1)).toEqual([message("m1", "hoi")]);
    await saveChat(alice, 1, [message("m1", "hoi"), message("m3", "nog een")]);
    expect((await loadChat(alice, 1)).map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(await IntelChat.countDocuments()).toBe(3);
  });

  test("clearChat removes only that user's chat about that item", async () => {
    await saveChat(alice, 1, [message("m1", "hoi")]);
    await saveChat(bob, 1, [message("b1", "hoi")]);
    await clearChat(alice, 1);
    expect(await loadChat(alice, 1)).toEqual([]);
    expect(await loadChat(bob, 1)).toHaveLength(1);
  });
});
