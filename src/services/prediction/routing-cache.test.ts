import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { readCache, writeCache } from "./routing-cache";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("routing cache", () => {
  test("returns written values until they expire", async () => {
    await writeCache("route:a>b", { line: [[5, 52], [5.1, 52]], distanceM: 1 }, 60_000);
    expect(await readCache<unknown>("route:a>b")).toEqual({ line: [[5, 52], [5.1, 52]], distanceM: 1 });
    await writeCache("route:a>b", { distanceM: 2 }, 60_000);
    expect(await readCache<unknown>("route:a>b")).toEqual({ distanceM: 2 });
    await writeCache("old", { distanceM: 3 }, -1);
    expect(await readCache("old")).toBeUndefined();
    expect(await readCache("missing")).toBeUndefined();
  });
});
