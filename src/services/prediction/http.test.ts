import { describe, expect, test } from "bun:test";
import { createThrottle, DailyCounter, MinuteBudget } from "./http";

describe("createThrottle", () => {
  test("spaces task starts by the interval and keeps order", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const order: number[] = [];
    const schedule = createThrottle(1000, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([1, 2, 3].map((n) => schedule(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  test("a failing task does not block the next one", async () => {
    const schedule = createThrottle(0);
    await expect(schedule(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await schedule(async () => 42)).toBe(42);
  });
});

describe("DailyCounter", () => {
  test("allows `limit` calls per UTC day", () => {
    let now = new Date("2026-10-17T10:00:00Z");
    const counter = new DailyCounter(2, () => now);
    expect([counter.tryConsume(), counter.tryConsume(), counter.tryConsume()]).toEqual([true, true, false]);
    now = new Date("2026-10-18T00:00:01Z");
    expect(counter.tryConsume()).toBe(true);
  });
});

describe("MinuteBudget", () => {
  test("allows `limit` starts per rolling minute, then waits until the oldest one is a minute old", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const budget = new MinuteBudget(2, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await budget.acquire();
    clock = 10_000;
    await budget.acquire();
    expect(sleeps).toEqual([]);
    clock = 30_000;
    await budget.acquire();
    expect(sleeps).toEqual([30_000]);
    expect(clock).toBe(60_000);
    // Starts at 10 s and 60 s are in the window; the next slot opens at 70 s.
    await budget.acquire();
    expect(sleeps).toEqual([30_000, 10_000]);
  });
});
