import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { mockModel } from "../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { GeminiError } from "./ai/gemini-error";
import { getBoardJson, invalidateBoardCache } from "./hint-board.service";
import { DEFAULT_AREAS } from "./hint-parser";
import {
  applyHintSplit,
  buildHintSplitPrompt,
  createHintSplitJob,
  createHintSplitter,
  findPendingHintSplits,
  HINT_SPLIT_MAX_PAUSE_MS,
  HINT_SPLIT_PAUSE_MS,
  hintBlocks,
  snippetFor,
  type HintSplit,
  type HintSplitter,
} from "./hint-split.service";

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

  test("a real Trix image attachment is labelled by its attachment filename", () => {
    const html =
      `<div>Oscar:<br><figure data-trix-attachment="{&quot;contentType&quot;:&quot;image/png&quot;,&quot;filename&quot;:&quot;Hint Oscar.png&quot;,&quot;filesize&quot;:12345,&quot;url&quot;:&quot;https://cdn.jotihunt.net/NELCynV1WhOy8LaNELWKMxXJmGWmO8DE99RwS90E.png&quot;,&quot;width&quot;:1042}" data-trix-content-type="image/png" class="attachment attachment--preview attachment--png">` +
      `<img src="https://cdn.jotihunt.net/NELCynV1WhOy8LaNELWKMxXJmGWmO8DE99RwS90E.png" width="1042" height="539">` +
      `<figcaption class="attachment__caption"><span class="attachment__name">Hint Oscar.png</span> <span class="attachment__size">12.06 KB</span></figcaption></figure></div>`;
    const blocks = hintBlocks(html);
    expect(blocks.map((block) => block.text)).toEqual(["Oscar:", "[afbeelding: Hint Oscar.png]"]);
    expect(blocks[1].html).toContain("<img");
    expect(blocks[1].html).toContain("</figure>");
  });

  test("an image figure without trix filename uses the caption name, then alt, then the src file name", () => {
    const caption = `<figure><img src="/x/a1.png" alt="Alt"><figcaption><span class="attachment__name">Bravo.png</span></figcaption></figure>`;
    const alt = `<figure><img src="/x/a2.png" alt="Charlie"></figure>`;
    const src = `<figure data-trix-attachment="{broken"><img src="/x/delta.png"></figure>`;
    expect(hintBlocks(caption + alt + src).map((block) => block.text)).toEqual(["[afbeelding: Bravo.png]", "[afbeelding: Charlie]", "[afbeelding: delta.png]"]);
  });

  test("a Trix file attachment is kept as [bestand: name]", () => {
    const withName =
      `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;application/zip&quot;,&quot;filename&quot;:&quot;alpha.zip&quot;}" class="attachment attachment--file attachment--zip">` +
      `<a href="https://cdn.jotihunt.net/jotihunt2025-files/x1.zip"><figcaption class="attachment__caption"><span class="attachment__name">alpha.zip</span></figcaption></a></figure>`;
    const byHref = `<figure class="attachment attachment--file"><a href="https://cdn.jotihunt.net/jotihunt2025-files/bravo.zip"></a></figure>`;
    const blocks = hintBlocks(withName + byHref);
    expect(blocks.map((block) => block.text)).toEqual(["[bestand: alpha.zip]", "[bestand: bravo.zip]"]);
    expect(blocks[0].html).toContain("<a href");
  });

  test("a link without text is kept as [bestand: name]; a link with text keeps its text", () => {
    const blocks = hintBlocks(`<div><a href="https://cdn.jotihunt.net/files/echo.pdf"></a></div><div><a href="https://x.nl/a">klik</a></div>`);
    expect(blocks.map((block) => block.text)).toEqual(["[bestand: echo.pdf]", "klik"]);
  });

  test("a link around an image is only the image; a link without href gets no label", () => {
    const blocks = hintBlocks(`<div><a href="https://cdn.jotihunt.net/big.png"><img src="https://cdn.jotihunt.net/big.png"></a></div><div>Golf:<a name="x"></a></div>`);
    expect(blocks.map((block) => block.text)).toEqual(["[afbeelding: big.png]", "Golf:"]);
  });

  test("also cuts after </blockquote>, </ul>, </ol> and </pre>", () => {
    const blocks = hintBlocks("<blockquote>a</blockquote>b<br><ul><li>c</li></ul>d<br><pre>e</pre>f<br><ol><li>g</li></ol>h");
    expect(blocks.map((block) => block.text)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(blocks.find((block) => block.text === "e")!.html).toBe("<pre>e</pre>");
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
    expect(prompt).toContain("[afbeelding: name]");
    expect(prompt).toContain("[bestand: name]");
    expect(prompt).toContain('a lone "Alpha:" line');
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

  test("writes no cells when the stored content changed since the split was made", async () => {
    await makeArticle("h2");
    await cell("alpha", HintCellStatus.None);
    const { changed } = await applyHintSplit({ id: 1, content, contentHash: "h1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(changed).toEqual([]);
    expect(await find("alpha")).toMatchObject({ status: HintCellStatus.None });
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBeUndefined();
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

describe("findPendingHintSplits", () => {
  test("hint articles whose current content has no split yet, newest first", async () => {
    const at = (hour: number) => new Date(`2026-10-17T${hour}:00:00Z`);
    await Article.create([
      { id: 1, title: "Oud", type: "hint", publishAt: at(10), content: "a", contentHash: "h1" },
      { id: 2, title: "Nieuw", type: "hint", publishAt: at(12), content: "b", contentHash: "h2" },
      { id: 3, title: "Gesplitst", type: "hint", publishAt: at(13), content: "c", contentHash: "h3", hintSplitHash: "h3" },
      { id: 4, title: "Gewijzigd", type: "hint", publishAt: at(11), content: "d", contentHash: "h4b", hintSplitHash: "h4" },
      { id: 5, title: "Nieuws", type: "news", publishAt: at(14), content: "e", contentHash: "h5" },
      { id: 6, title: "Zonder hash", type: "hint", publishAt: at(15), content: "f" },
    ]);
    const pending = await findPendingHintSplits(10);
    expect(pending.map((article) => article.id)).toEqual([2, 4, 1]);
    expect(pending[0]).toEqual({ id: 2, title: "Nieuw", content: "b", contentHash: "h2" });
    expect((await findPendingHintSplits(1)).map((article) => article.id)).toEqual([2]);
  });
});

describe("createHintSplitJob", () => {
  const publishAt = new Date("2026-10-17T12:00:00.000Z");
  const hint = (id: number, contentHash = `h${id}`) => Article.create({ id, title: `Hint ${id}`, type: "hint", publishAt, content: SAMPLE, contentHash });
  const noneCell = (articleId: number, area = "alpha") => HintCell.create({ articleId, area, publishAt, slotTime: publishAt, status: HintCellStatus.None });
  const alphaOpen: HintSplit = [{ area: "alpha", none: false, blocks: [1] }];
  const splitter = (split: HintSplitter["split"]): HintSplitter => ({ split });
  const unreachable = () => new GeminiError("Gemini niet bereikbaar", true);
  const invalid = () => new GeminiError("Gemini gaf geen geldig antwoord", false);

  test("the pause after an outage is 2 minutes, at most 15", () => {
    expect(HINT_SPLIT_PAUSE_MS).toBe(120_000);
    expect(HINT_SPLIT_MAX_PAUSE_MS).toBe(900_000);
  });

  test("splits a pending hint, applies it to the cells and marks the article as split", async () => {
    await hint(1);
    await noneCell(1);
    const seen: { title: string; areas: string[] }[] = [];
    const job = createHintSplitJob({
      splitter: splitter(async (article, areas) => {
        seen.push({ title: article.title, areas });
        return alphaOpen;
      }),
      areas: async () => AREAS,
    });
    expect(await job.run()).toEqual({ done: [1], failed: [] });
    expect(seen).toEqual([{ title: "Hint 1", areas: AREAS }]);
    expect((await HintCell.findOne({ articleId: 1, area: "alpha" }).lean())!.status).toBe(HintCellStatus.Open);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe("h1");
    expect((await job.run()).done).toEqual([]);
  });

  test("areas default to the area names the cells are made for", async () => {
    await hint(1);
    let given: string[] = [];
    await createHintSplitJob({
      splitter: splitter(async (_, areas) => {
        given = areas;
        return alphaOpen;
      }),
    }).run();
    expect(given).toEqual([...DEFAULT_AREAS]);
  });

  test("one article per run by default, at most `batch` when given", async () => {
    for (const id of [1, 2, 3]) await hint(id);
    const ok = splitter(async () => alphaOpen);
    expect((await createHintSplitJob({ splitter: ok, areas: async () => AREAS }).run()).done).toHaveLength(1);
    expect((await createHintSplitJob({ splitter: ok, areas: async () => AREAS, batch: 5 }).run()).done).toHaveLength(2);
  });

  test("a non-retryable failure is tried twice for the same content, then left alone; a content change resets", async () => {
    await hint(1);
    let calls = 0;
    const job = createHintSplitJob({
      splitter: splitter(async () => {
        calls++;
        throw invalid();
      }),
      areas: async () => AREAS,
    });
    expect((await job.run()).failed.map((failure) => failure.id)).toEqual([1]);
    await job.run();
    await job.run();
    expect(calls).toBe(2);
    await Article.updateOne({ id: 1 }, { $set: { contentHash: "nieuw" } });
    await job.run();
    expect(calls).toBe(3);
  });

  test("a retryable failure pauses 2 minutes, then 4, and does not count toward giving up", async () => {
    await hint(1);
    let time = 0;
    let calls = 0;
    let failing = true;
    const job = createHintSplitJob({
      splitter: splitter(async () => {
        calls++;
        if (failing) throw unreachable();
        return alphaOpen;
      }),
      areas: async () => AREAS,
      now: () => time,
    });
    expect((await job.run()).failed[0].error).toBeInstanceOf(GeminiError);
    time += HINT_SPLIT_PAUSE_MS - 1;
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect(calls).toBe(1);
    time += 1;
    await job.run();
    expect(calls).toBe(2);
    time += 2 * HINT_SPLIT_PAUSE_MS - 1;
    await job.run();
    expect(calls).toBe(2);
    time += 1;
    await job.run();
    expect(calls).toBe(3);
    time += 4 * HINT_SPLIT_PAUSE_MS;
    failing = false;
    expect((await job.run()).done).toEqual([1]);
  });

  test("a demo switch (tracked skipped) stops the run without applying", async () => {
    await hint(1);
    await hint(2);
    await noneCell(1);
    await noneCell(2);
    let calls = 0;
    const job = createHintSplitJob({
      splitter: splitter(async () => {
        calls++;
        return alphaOpen;
      }),
      areas: async () => AREAS,
      batch: 2,
      // The read passes, the apply is skipped: a demo switch happened during the Gemini call
      beginRun: () => {
        let reads = 0;
        return async (fn) => (reads++ === 0 ? fn() : undefined);
      },
    });
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect(calls).toBe(1);
    expect(await HintCell.countDocuments({ status: HintCellStatus.None })).toBe(2);
    expect(await Article.countDocuments({ hintSplitHash: { $exists: true } })).toBe(0);
  });
});
