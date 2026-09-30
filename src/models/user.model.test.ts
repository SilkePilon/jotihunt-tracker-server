import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setTutorialVersion, User } from "./user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

async function createUser() {
  return User.create({ email: "tour@example.com", password: "x", name: "Tour" });
}

describe("tutorialVersion", () => {
  test("defaults to 0", async () => {
    const user = await createUser();
    expect(user.tutorialVersion).toBe(0);
  });

  test("setTutorialVersion stores the version", async () => {
    const user = await createUser();
    expect(await setTutorialVersion(user, 2)).toBe(2);
    const reloaded = await User.findById(user._id);
    expect(reloaded!.tutorialVersion).toBe(2);
  });

  test("setTutorialVersion never lowers the version", async () => {
    const user = await createUser();
    await setTutorialVersion(user, 3);
    expect(await setTutorialVersion(user, 1)).toBe(3);
  });

  test("users stored before the field existed read as 0", async () => {
    await User.collection.insertOne({ email: "old@example.com", password: "x", name: "Old", admin: false, requiresPasswordChange: false });
    const user = await User.findOne({ email: "old@example.com" });
    expect(user!.tutorialVersion).toBe(0);
  });
});
