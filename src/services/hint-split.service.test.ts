import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { mockModel } from "../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { GeminiError } from "./ai/gemini-error";
import { getBoardJson, invalidateBoardCache } from "./hint-board.service";
import { applyHintSplit, buildHintSplitPrompt, createHintSplitter, hintBlocks, snippetFor } from "./hint-split.service";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const SAMPLE = "intro<br>Alpha: <img src='/x/a.png' alt='A'><br>Bravo: -";
const AREAS = ["alpha", "bravo", "charlie"];

describe("hintBlocks", () => {
  test("splits at <br>, keeps the image html, writes images as [afbeelding: alt]", () => {
    const blocks = hintBlocks(SAMPLE);
    expect(blocks.map((block) => block.text)).toEqual(["intro", "Alpha: [afbeelding: A]", "Bravo: -"]);
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2]);
    expect(blocks[1].html).toContain("<img");
  });

  test("splits at </p>, </div> and </li> (keeping the closing tag) and drops whitespace-only blocks", () => {
    const blocks = hintBlocks("<p>Intro</p>  <div>Alpha: 1</div><br> &nbsp; <br><ul><li>Bravo: 2</li><li>Charlie:\n  3</li></ul>");
    expect(blocks.map((block) => block.text)).toEqual(["Intro", "Alpha: 1", "Bravo: 2", "Charlie: 3"]);
    expect(blocks[0].html).toBe("<p>Intro</p>");
    expect(blocks[1].html).toContain("</div>");
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2, 3]);
  });

  test("an image without alt uses its file name; a block with only an image is kept", () => {
    const blocks = hintBlocks('<div><img src="https://cdn.example/files/delta-puzzel.png?x=1"></div>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("[afbeelding: delta-puzzel.png]");
  });

  test("&nbsp; becomes a space and whitespace collapses", () => {
    expect(hintBlocks("Alpha:&nbsp;&nbsp;  12<br>")[0].text).toBe("Alpha: 12");
  });
});

describe("buildHintSplitPrompt", () => {
  test("lists every block as [n] text, the areas, and says '-' means no hint", () => {
    const prompt = buildHintSplitPrompt({ title: "Hint 3", content: SAMPLE }, AREAS);
    expect(prompt).toContain("[0] intro");
    expect(prompt).toContain("[1] Alpha: [afbeelding: A]");
    expect(prompt).toContain("[2] Bravo: -");
    for (const area of AREAS) expect(prompt.toLowerCase()).toContain(area);
    expect(prompt).toContain('"-"');
    expect(prompt).toContain("no hint");
    expect(prompt).toContain("Hint 3");
  });
});

describe("createHintSplitter", () => {
  const article = { title: "Hint", content: SAMPLE };
  const splitWith = (answer: unknown) => createHintSplitter({ model: mockModel(() => JSON.stringify(answer)) }).split(article, AREAS);

  test("sends the prompt with a JSON schema and temperature 0.1", async () => {
    const model = mockModel(() => JSON.stringify({ areas: [{ area: "alpha", none: false, blocks: [1] }] }));
    await createHintSplitter({ model }).split(article, AREAS);
    const [call] = model.doGenerateCalls;
    const text = (call.prompt[0].content as { text: string }[])[0].text;
    expect(text).toContain("[1] Alpha: [afbeelding: A]");
    expect(call.responseFormat).toMatchObject({ type: "json" });
    expect((call.responseFormat as { schema?: unknown }).schema).toBeDefined();
    expect(call.temperature).toBe(0.1);
  });

  test("drops unknown areas, out-of-range and duplicate blocks; compares areas case-insensitively", async () => {
    const split = await splitWith({
      areas: [
        { area: "Alpha", none: false, blocks: [1, 1, 7, -1, 0.5] },
        { area: "zulu", none: false, blocks: [0] },
        { area: "BRAVO", none: true, blocks: [] },
      ],
    });
    expect(split).toEqual([
      { area: "alpha", none: false, blocks: [1] },
      { area: "bravo", none: true, blocks: [] },
    ]);
  });

  test("none with blocks is treated as not none", async () => {
    const split = await splitWith({ areas: [{ area: "alpha", none: true, blocks: [1] }] });
    expect(split).toEqual([{ area: "alpha", none: false, blocks: [1] }]);
  });

  test("an area with no usable blocks and not none is unknown (dropped, keeps the rule result)", async () => {
    const split = await splitWith({
      areas: [
        { area: "alpha", none: false, blocks: [] },
        { area: "bravo", none: false, blocks: [9] },
        { area: "charlie", none: false, blocks: [2] },
      ],
    });
    expect(split).toEqual([{ area: "charlie", none: false, blocks: [2] }]);
    const error = await splitWith({ areas: [{ area: "alpha", none: false, blocks: [] }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
  });

  test("an answer with no usable area is an invalid answer", async () => {
    for (const answer of [{ areas: [{ area: "zulu", none: false, blocks: [1] }] }, { areas: [] }, { nope: 1 }]) {
      const error = await splitWith(answer).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GeminiError);
      expect((error as GeminiError).retryable).toBe(false);
    }
  });

  test("a failing call becomes a GeminiError", async () => {
    const model = mockModel(() => {
      throw new TypeError("fetch failed");
    });
    const error = await createHintSplitter({ model }).split(article, AREAS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).retryable).toBe(true);
  });
});

describe("snippetFor", () => {
  test("joins the original html of the blocks in index order", () => {
    const blocks = hintBlocks("a<br>b<br>c");
    expect(snippetFor(blocks, { area: "alpha", none: false, blocks: [2, 0] })).toBe("a<br>c");
  });

  test("undefined when none or no blocks", () => {
    const blocks = hintBlocks("a<br>b");
    expect(snippetFor(blocks, { area: "alpha", none: true, blocks: [] })).toBeUndefined();
    expect(snippetFor(blocks, { area: "alpha", none: false, blocks: [] })).toBeUndefined();
  });
});

describe("applyHintSplit", () => {
  const content = SAMPLE;
  const slotTime = new Date("2026-10-17T12:00:00.000Z");
  const cell = (area: string, status: HintCellStatus, extra: Record<string, unknown> = {}) =>
    HintCell.create({ articleId: 1, area, publishAt: slotTime, slotTime, status, ...extra });
  const makeArticle = (contentHash = "h1") => Article.create({ id: 1, title: "Hint", type: "hint", publishAt: slotTime, content, contentHash });
  const find = async (area: string) => (await HintCell.findOne({ articleId: 1, area }).lean())!;

  test("an open cell becomes none (snippet unset); a none cell becomes open with its snippet", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.None);
    await cell("bravo", HintCellStatus.Open, { snippet: "Bravo: -" });
    const { changed } = await applyHintSplit({ id: 1, content, contentHash: "h1" }, [
      { area: "alpha", none: false, blocks: [1] },
      { area: "bravo", none: true, blocks: [] },
    ]);
    expect(changed.sort()).toEqual(["alpha", "bravo"]);
    const alpha = await find("alpha");
    expect(alpha.status).toBe(HintCellStatus.Open);
    expect(alpha.snippet).toContain("<img");
    const bravo = await find("bravo");
    expect(bravo.status).toBe(HintCellStatus.None);
    expect(bravo).not.toHaveProperty("snippet");
  });

  test("a solved cell is untouched", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.Solved, { answer: "1234 5678", snippet: "oud" });
    const { changed } = await applyHintSplit({ id: 1, content, contentHash: "h1" }, [{ area: "alpha", none: true, blocks: [] }]);
    expect(changed).toEqual([]);
    expect(await find("alpha")).toMatchObject({ status: HintCellStatus.Solved, answer: "1234 5678", snippet: "oud" });
  });

  test("an area missing from the split is untouched; an unchanged cell is not reported", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.Open, { snippet: "Alpha: <img src='/x/a.png' alt='A'><br>" });
    await cell("charlie", HintCellStatus.Open, { snippet: "c" });
    const { changed } = await applyHintSplit({ id: 1, content, contentHash: "h1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(changed).toEqual([]);
    expect(await find("charlie")).toMatchObject({ status: HintCellStatus.Open, snippet: "c" });
  });

  test("a cell solved between the read and the write stays solved and untouched", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.None);
    const findOne = HintCell.findOne.bind(HintCell);
    const spy = spyOn(HintCell, "findOne").mockImplementation(((...args: Parameters<typeof HintCell.findOne>) => ({
      lean: async () => {
        const read = await findOne(...args).lean();
        // A hunter solves the cell right after applyHintSplit read it
        await HintCell.collection.updateOne({ articleId: 1, area: "alpha" }, { $set: { status: HintCellStatus.Solved, answer: "1234 5678" } });
        return read;
      },
    })) as unknown as typeof HintCell.findOne);
    try {
      const { changed } = await applyHintSplit({ id: 1, content, contentHash: "h1" }, [{ area: "alpha", none: false, blocks: [1] }]);
      expect(spy).toHaveBeenCalled();
      expect(changed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const alpha = await find("alpha");
    expect(alpha).toMatchObject({ status: HintCellStatus.Solved, answer: "1234 5678" });
    expect(alpha).not.toHaveProperty("snippet");
  });

  test("sets hintSplitHash, but not when the content changed meanwhile", async () => {
    await makeArticle("h1");
    await applyHintSplit({ id: 1, content, contentHash: "h1" }, []);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe("h1");
    await Article.updateOne({ id: 1 }, { $set: { contentHash: "h2" } });
    await applyHintSplit({ id: 1, content, contentHash: "h1-old" }, []);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe("h1");
  });

  test("invalidates the board cache when something changed", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.None);
    invalidateBoardCache();
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.None);
    await applyHintSplit({ id: 1, content, contentHash: "h1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.Open);
  });
});
