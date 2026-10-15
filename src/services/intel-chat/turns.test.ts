import { describe, expect, test } from "bun:test";
import { discardTurn, endTurn, startTurn } from "./turns";

describe("discardTurn", () => {
  test("holds the chat while the callback runs (a new turn is busy), then frees it", async () => {
    let busyDuring: boolean | undefined;
    await discardTurn("u1", 1, async () => {
      busyDuring = startTurn("u1", 1) === null;
    });
    expect(busyDuring).toBe(true);
    const next = startTurn("u1", 1);
    expect(next).not.toBeNull();
    endTurn(next!);
  });

  test("a running turn is stopped and its own end does not free the chat before the callback finished", async () => {
    const turn = startTurn("u2", 1)!;
    let releaseSave!: () => void;
    turn.saving = new Promise<void>((resolve) => (releaseSave = resolve));
    const order: string[] = [];
    const discarding = discardTurn("u2", 1, async () => {
      order.push("clear");
      // The stopped turn ends (its onEnd/saveTurn) while the chat is being cleared
      endTurn(turn);
      order.push(startTurn("u2", 1) === null ? "busy" : "free");
    });
    expect(turn.discarded).toBe(true);
    expect(turn.abort.signal.aborted).toBe(true);
    await Bun.sleep(10);
    expect(order).toEqual([]);
    releaseSave();
    await discarding;
    expect(order).toEqual(["clear", "busy"]);
    const next = startTurn("u2", 1);
    expect(next).not.toBeNull();
    endTurn(next!);
  });

  test("frees the chat when the callback fails", async () => {
    await expect(discardTurn("u3", 1, async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    const next = startTurn("u3", 1);
    expect(next).not.toBeNull();
    endTurn(next!);
  });
});
