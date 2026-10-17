import { describe, expect, test } from "bun:test";
import { discardTurn, endTurn, followTurn, runTurnStream, startTurn } from "./turns";

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

describe("runTurnStream + followTurn", () => {
  const chunk = (delta: string) => ({ type: "text-delta" as const, id: "t", delta });

  test("a follower that joins late gets every chunk from the start, then the live ones, then the end", async () => {
    const turn = startTurn("u4", 1)!;
    let push!: (delta: string) => void;
    let finish!: () => void;
    const source = new ReadableStream({
      start(controller) {
        push = (delta) => controller.enqueue(chunk(delta));
        finish = () => controller.close();
      },
    });
    const running = runTurnStream(turn, source);
    push("a");
    push("b");
    await Bun.sleep(5);
    const late = followTurn(turn, new AbortController().signal);
    const reading = Array.fromAsync(late);
    push("c");
    finish();
    await running;
    expect((await reading).map((c) => (c as { delta: string }).delta)).toEqual(["a", "b", "c"]);
    expect(turn.listeners.size).toBe(0);
    endTurn(turn);
  });

  test("a follower that leaves stops only its copy; the turn reads on", async () => {
    const turn = startTurn("u5", 1)!;
    let push!: (delta: string) => void;
    let finish!: () => void;
    const source = new ReadableStream({
      start(controller) {
        push = (delta) => controller.enqueue(chunk(delta));
        finish = () => controller.close();
      },
    });
    const running = runTurnStream(turn, source);
    const gone = new AbortController();
    const reading = Array.fromAsync(followTurn(turn, gone.signal));
    push("a");
    await Bun.sleep(5);
    gone.abort();
    push("b");
    finish();
    await running;
    expect((await reading).length).toBeLessThanOrEqual(1);
    expect(turn.chunks.length).toBe(2);
    expect(turn.streamDone).toBe(true);
    expect(turn.listeners.size).toBe(0);
    endTurn(turn);
  });
});
