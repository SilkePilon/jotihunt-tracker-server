# Hint cell `solvedAt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record when a hint cell was first solved and send it on the hint board, so the Intel window can show the average solve time.

**Architecture:** New optional `solvedAt` Date on `HintCell`. `solveCell` sets it only when the cell was not solved yet; `reopenImportedCell` unsets it. The board's `shown()` mapper fills a missing `solvedAt` of a solved cell from its marker ObjectId timestamp (no migration). The demo world gives solved cells a plausible `solvedAt`.

**Tech Stack:** Bun, TypeScript, Mongoose, bun:test (MongoDB `jotihunt-test` in docker).

Spec: client repo `docs/superpowers/specs/2026-10-16-intel-window-redesign-design.md` §6.

## Global Constraints

- `bun` is not on PATH: run `npx --yes bun test <file>` and `npx --yes bun x tsc --noEmit`.
- MongoDB runs in docker `jotihunt-mongodb-1`; tests use the `jotihunt-test` DB via `src/test/db`.
- Never restart the docker stack; never `pkill -f`.
- Work on branch `feat/intel-redesign` (create from `main`). Check `git branch --show-current` first.
- Code comments in the existing style: short, explain why.

---

### Task 1: `solvedAt` on hint cells

**Files:**
- Modify: `src/models/hint-cell.model.ts` (schema)
- Modify: `src/services/hint-board.service.ts` (`shown`, `solveCell`, `reopenImportedCell`)
- Modify: `src/demo/generator/generate-world.ts` (`applyCellPlans`)
- Test: `src/services/hint-board.service.test.ts`

**Interfaces:**
- Produces: board cells (`GET /hints/board` → `cells[]`) and solve responses carry `solvedAt?: string` (ISO) for solved cells. Client spec relies on this name.

- [ ] **Step 1: Create the branch**

```bash
cd jotihunt-tracker-server
git switch main && git switch -c feat/intel-redesign
```

- [ ] **Step 2: Write the failing tests**

Add to `src/services/hint-board.service.test.ts` (imports: add `reopenImportedCell` to the `./hint-board.service` import, and `import mongoose from "mongoose";` at the top):

```ts
describe("solvedAt", () => {
  test("is set on the first solve and kept when the answer changes", async () => {
    await makeCell();
    const before = Date.now();
    const first = await solveCell(1, "alpha", "2126 4692");
    expect(first.solvedAt).toBeInstanceOf(Date);
    expect(first.solvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await solveCell(1, "alpha", "kerk");
    expect(second.solvedAt!.getTime()).toBe(first.solvedAt!.getTime());
  });

  test("an open cell has none", async () => {
    await makeCell();
    const board = await getBoard();
    expect(board.cells[0].solvedAt).toBeUndefined();
  });

  test("reopening an imported cell clears it", async () => {
    const cell = await makeCell();
    await solveCell(1, "alpha", "kerk");
    expect(await reopenImportedCell(cell._id, "kerk")).toBe(true);
    const stored = await HintCell.findById(cell._id).lean();
    expect(stored?.solvedAt).toBeUndefined();
  });

  test("an old solved cell without solvedAt gets its marker's creation time", async () => {
    const markerId = new mongoose.Types.ObjectId();
    await HintCell.create({ articleId: 1, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "x", answerKind: "rd", markerId });
    const board = await getBoard();
    expect(new Date(board.cells[0].solvedAt!).getTime()).toBe(markerId.getTimestamp().getTime());
  });

  test("an old solved text answer without marker stays without", async () => {
    await HintCell.create({ articleId: 1, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "kerk", answerKind: "text" });
    const board = await getBoard();
    expect(board.cells[0].solvedAt).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx --yes bun test src/services/hint-board.service.test.ts`
Expected: the new `solvedAt` tests FAIL (`solvedAt` undefined / TS property missing); older tests PASS.

- [ ] **Step 4: Schema field**

In `src/models/hint-cell.model.ts`, after `markerId`:

```ts
  /** When the cell was first solved (kept when the answer changes); missing on cells solved before this field existed */
  solvedAt: { type: Date },
```

- [ ] **Step 5: `shown` fills the fallback**

Replace `shown` in `src/services/hint-board.service.ts`:

```ts
/**
 * A cell as sent to clients: a legacy "solving" cell counts as open; a solved cell from before `solvedAt` existed gets
 * its marker's creation time (the marker is made by the solve), a text answer without marker stays without.
 */
function shown<T extends { status: string; solvedAt?: Date | null; markerId?: mongoose.Types.ObjectId | null }>(cell: T): T {
  if (cell.status === "solving") return { ...cell, status: HintCellStatus.Open };
  if (cell.status === HintCellStatus.Solved && !cell.solvedAt && cell.markerId) return { ...cell, solvedAt: cell.markerId.getTimestamp() };
  return cell;
}
```

- [ ] **Step 6: Set it in `solveCell`, clear it in `reopenImportedCell`**

In `solveCell`'s `HintCell.updateOne` `$set`, add after `status: HintCellStatus.Solved,`:

```ts
          // First solve only: changing the answer later keeps the original time
          ...(cell.status !== HintCellStatus.Solved ? { solvedAt: new Date() } : {}),
```

In `reopenImportedCell`, change the `$unset` to:

```ts
    { $set: { status: HintCellStatus.Open }, $unset: { answer: 1, answerKind: 1, answerLocation: 1, markerId: 1, solvedAt: 1 } },
```

(`readCell` must return `status`; check it does — it is used for `onlyIfOpen` already.)

- [ ] **Step 7: Run the tests**

Run: `npx --yes bun test src/services/hint-board.service.test.ts`
Expected: all PASS.

- [ ] **Step 8: Demo world**

In `src/demo/generator/generate-world.ts` `applyCellPlans`: fetch `publishAt` too and give solved cells a solve time 8–37 min after publish, deterministic per cell (the marker ids are created now, so the fallback would say "just now"):

```ts
  const cells = await HintCell.find({}, { articleId: 1, area: 1, slotTime: 1, publishAt: 1 }).lean();
```

and inside `if (plan.status === HintCellStatus.Solved && area) { … }`, extend the `Object.assign(set, …)`:

```ts
      // A believable solve time (8–37 min after publish), the same for a cell on every run
      const minutes = 8 + ((plan.articleId * 31 + plan.area.charCodeAt(0) * 7) % 30);
      Object.assign(set, { answer, answerKind: "rd", answerLocation: [rd.lng, rd.lat], markerId: null, solvedAt: new Date(cell.publishAt.getTime() + minutes * 60_000) });
```

- [ ] **Step 9: Full check**

Run: `npx --yes bun x tsc --noEmit && npx --yes bun test`
Expected: tsc clean, all tests PASS (the demo tests in `src/demo` included).

- [ ] **Step 10: Commit**

```bash
git add src/models/hint-cell.model.ts src/services/hint-board.service.ts src/services/hint-board.service.test.ts src/demo/generator/generate-world.ts
git commit -m "feat(hints): record solvedAt on hint cells

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
