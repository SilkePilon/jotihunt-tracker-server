import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import mongoose, { type Connection } from "mongoose";
import { decryptSession, encryptSession } from "../services/telegram.helpers";
import { LIFE360_LINK_KEY, life360LinkModel } from "./life360-link.model";

const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
/** Stands in for the demo state store's connection to the real database */
let realDb: Connection;

beforeAll(async () => {
  realDb = await mongoose.createConnection(uri).asPromise();
  await life360LinkModel(realDb).syncIndexes();
});
beforeEach(async () => {
  await life360LinkModel(realDb).deleteMany({});
});
afterAll(async () => {
  await realDb.close();
});

test("one link document (key life360) with the token encrypted at rest", async () => {
  const key = randomBytes(32).toString("base64");
  const sealed = encryptSession("life360-token-secret", key);
  const Links = life360LinkModel(realDb);
  const fields = {
    tokenCiphertext: sealed.ciphertext,
    iv: sealed.iv,
    tag: sealed.tag,
    email: "jotihunt@example.nl",
    deviceId: "0F8E2C3A-1111-2222-3333-444455556666",
    circleId: "c1",
    circleName: "Jotihunt",
    linkedBy: "Admin",
    linkedAt: new Date("2026-10-15T12:00:00Z"),
  };
  await Links.create(fields);

  const doc = await Links.findOne({ key: LIFE360_LINK_KEY }).lean();
  expect(doc).toMatchObject({ key: "life360", email: "jotihunt@example.nl", circleId: "c1", circleName: "Jotihunt", linkedBy: "Admin" });
  expect(JSON.stringify(doc)).not.toContain("life360-token-secret");
  expect(decryptSession({ ciphertext: doc!.tokenCiphertext, iv: doc!.iv, tag: doc!.tag }, key)).toBe("life360-token-secret");
  // Only one link
  await expect(Links.create(fields)).rejects.toMatchObject({ code: 11000 });
  // The same model on the same connection
  expect(life360LinkModel(realDb)).toBe(Links);
});
