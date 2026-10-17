import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Article, hintSplitKey, TEXT_DEBOUNCE_MS } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { mockModel } from "../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { GeminiError } from "./ai/gemini-error";
import { getBoardJson, invalidateBoardCache } from "./hint-board.service";
import { articleTextHash } from "./article-text-hash";
import { DEFAULT_AREAS } from "./hint-parser";
import {
  applyHintSplit,
  buildHintSplitPrompt,
  createHintSplitJob,
  createHintSplitter,
  findPendingHintSplits,
  migrateHintSplitKeys,
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
    expect(prompt).toContain("never names");
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
      // Never named in the article
      { area: "charlie", none: true, blocks: [] },
    ]);
  });

  test("an area left out or undecided becomes none only when no block or the title names it and another area got blocks", async () => {
    const split = await splitWith({ areas: [{ area: "alpha", none: false, blocks: [1] }] });
    // bravo is named ("Bravo: -"), charlie is not
    expect(split).toEqual([
      { area: "alpha", none: false, blocks: [1] },
      { area: "charlie", none: true, blocks: [] },
    ]);
    const titled = await createHintSplitter({ model: mockModel(() => JSON.stringify({ areas: [{ area: "alpha", none: false, blocks: [1] }] })) }).split({ title: "Hint Charlie", content: SAMPLE }, AREAS);
    expect(titled).toEqual([{ area: "alpha", none: false, blocks: [1] }]);
    // Only none answers: nothing is added
    expect(await splitWith({ areas: [{ area: "bravo", none: true, blocks: [] }] })).toEqual([{ area: "bravo", none: true, blocks: [] }]);
  });

  test("none with blocks is treated as not none", async () => {
    const split = await splitWith({ areas: [{ area: "alpha", none: true, blocks: [1] }] });
    expect(split[0]).toEqual({ area: "alpha", none: false, blocks: [1] });
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


/** Long before the debounce of any test run */
const STABLE = new Date("2026-01-01T00:00:00Z");

describe("applyHintSplit", () => {
  const content = SAMPLE;
  const slotTime = new Date("2026-10-17T12:00:00.000Z");
  const cell = (area: string, status: HintCellStatus, extra: Record<string, unknown> = {}) =>
    HintCell.create({ articleId: 1, area, publishAt: slotTime, slotTime, status, ...extra });
  const makeArticle = (textHash = "t1", extra: Record<string, unknown> = {}) =>
    Article.create({ id: 1, title: "Hint", type: "hint", publishAt: slotTime, content, contentHash: "h1", textHash, textChangedAt: STABLE, ...extra });
  const find = async (area: string) => (await HintCell.findOne({ articleId: 1, area }).lean())!;

  test("an open cell becomes none (snippet unset); a none cell becomes open with its snippet", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.None);
    await cell("bravo", HintCellStatus.Open, { snippet: "Bravo: -" });
    const { changed, stored } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [
      { area: "alpha", none: false, blocks: [1] },
      { area: "bravo", none: true, blocks: [] },
    ]);
    expect(stored).toBe(true);
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
    const { changed } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: true, blocks: [] }]);
    expect(changed).toEqual([]);
    expect(await find("alpha")).toMatchObject({ status: HintCellStatus.Solved, answer: "1234 5678", snippet: "oud" });
  });

  test("an area missing from the split is untouched; an unchanged cell is not reported", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.Open, { snippet: "Alpha: <img src='/x/a.png' alt='A'><br>" });
    await cell("charlie", HintCellStatus.Open, { snippet: "c" });
    const { changed } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: false, blocks: [1] }]);
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
      const { changed } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: false, blocks: [1] }]);
      expect(spy).toHaveBeenCalled();
      expect(changed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const alpha = await find("alpha");
    expect(alpha).toMatchObject({ status: HintCellStatus.Solved, answer: "1234 5678" });
    expect(alpha).not.toHaveProperty("snippet");
  });

  test("sets hintSplitHash to the split key of the text, but not when the text changed meanwhile", async () => {
    await makeArticle("t1");
    expect((await applyHintSplit({ id: 1, content, textHash: "t1" }, [])).stored).toBe(true);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey("t1"));
    await Article.updateOne({ id: 1 }, { $set: { textHash: "t2" } });
    expect((await applyHintSplit({ id: 1, content, textHash: "t1-old" }, [])).stored).toBe(false);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey("t1"));
  });

  test("writes no cells and stores nothing when the stored text changed since the split was made", async () => {
    await makeArticle("t2");
    await cell("alpha", HintCellStatus.None);
    const { changed, stored } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(stored).toBe(false);
    expect(changed).toEqual([]);
    expect(await find("alpha")).toMatchObject({ status: HintCellStatus.None });
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBeUndefined();
  });

  test("a markup-only re-save during the split: the split is applied with the snippets of the current HTML", async () => {
    // Same text and blocks, rotated (signed) image URL
    const current = "intro<br>Alpha: <img src='/y/a.png?sig=2' alt='A'><br>Bravo: -";
    await makeArticle("t1", { content: current, contentHash: "h2" });
    await cell("alpha", HintCellStatus.None);
    const { changed, stored } = await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(stored).toBe(true);
    expect(changed).toEqual(["alpha"]);
    expect((await find("alpha")).snippet).toContain("/y/a.png?sig=2");
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey("t1"));
  });

  test("invalidates the board cache when something changed", async () => {
    await makeArticle();
    await cell("alpha", HintCellStatus.None);
    invalidateBoardCache();
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.None);
    await applyHintSplit({ id: 1, content, textHash: "t1" }, [{ area: "alpha", none: false, blocks: [1] }]);
    expect(JSON.parse(await getBoardJson()).cells[0].status).toBe(HintCellStatus.Open);
  });
});

describe("findPendingHintSplits", () => {
  const at = (hour: number) => new Date(`2026-10-17T${hour}:00:00Z`);

  test("hint articles whose current text has no split yet, newest first, never seeded test hints", async () => {
    const hint = (id: number, hour: number, extra: Record<string, unknown> = {}) => ({ id, title: `Hint ${id}`, type: "hint", publishAt: at(hour), content: `c${id}`, contentHash: `h${id}`, textHash: `t${id}`, textChangedAt: STABLE, ...extra });
    await Article.create([
      hint(1, 10),
      hint(2, 12),
      hint(3, 13, { hintSplitHash: hintSplitKey("t3") }),
      hint(4, 11, { hintSplitHash: hintSplitKey("t4-oud") }),
      { ...hint(5, 14), type: "news" },
      hint(6, 15, { textHash: undefined }),
      hint(900001, 16),
    ]);
    const pending = await findPendingHintSplits(10);
    expect(pending.map((article) => article.id)).toEqual([2, 4, 1]);
    expect(pending[0]).toEqual({ id: 2, title: "Hint 2", content: "c2", textHash: "t2" });
    expect((await findPendingHintSplits(1)).map((article) => article.id)).toEqual([2]);
  });

  test("a changed text is pending only after it stayed the same for the debounce", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    await Article.create({ id: 1, title: "Hint", type: "hint", publishAt: at(10), content: "c", contentHash: "h", textHash: "t", textChangedAt: new Date(now.getTime() - TEXT_DEBOUNCE_MS + 1) });
    expect(await findPendingHintSplits(10, now)).toEqual([]);
    expect((await findPendingHintSplits(10, new Date(now.getTime() + 1))).map((article) => article.id)).toEqual([1]);
  });
});

describe("migrateHintSplitKeys", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const raw = (id: number, content: string, extra: Record<string, unknown> = {}) =>
    Article.collection.insertOne({ id, title: `Hint ${id}`, type: "hint", publishAt: new Date(`2026-10-17T1${id}:00:00Z`), content, contentHash: sha(content), textHash: articleTextHash(content), textChangedAt: STABLE, ...extra });

  test("re-keys splits of the current content without asking Gemini; others stay pending; idempotent", async () => {
    const content = (id: number) => `intro<br>Alpha: tekst ${id}<br>Bravo: -`;
    // Split done for the current content (old key = contentHash)
    await raw(1, content(1), { hintSplitHash: sha(content(1)) });
    // Never split
    await raw(2, content(2));
    // Split of older content
    await raw(3, content(3), { hintSplitHash: "oude-hash" });

    expect(await migrateHintSplitKeys()).toBe(1);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey(articleTextHash(content(1))));
    expect(await migrateHintSplitKeys()).toBe(0);

    const seen: number[] = [];
    const job = createHintSplitJob({ splitter: { split: async (article) => (seen.push(Number(article.title.split(" ")[1])), [{ area: "alpha", none: false, blocks: [1] }]) }, areas: async () => AREAS, batch: 10 });
    expect((await job.run()).done.sort()).toEqual([2, 3]);
    expect(seen.sort()).toEqual([2, 3]);
  });
});

describe("createHintSplitJob", () => {
  const publishAt = new Date("2026-10-17T12:00:00.000Z");
  const hint = (id: number, textHash = `t${id}`) => Article.create({ id, title: `Hint ${id}`, type: "hint", publishAt, content: SAMPLE, contentHash: `h${id}`, textHash, textChangedAt: STABLE });
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
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey("t1"));
    expect((await job.run()).done).toEqual([]);
  });

  test("a markup-only change of a split hint (same text) is not split again", async () => {
    await hint(1);
    let calls = 0;
    const job = createHintSplitJob({ splitter: splitter(async () => (calls++, alphaOpen)), areas: async () => AREAS });
    await job.run();
    await Article.updateOne({ id: 1 }, { $set: { contentHash: "h1-opnieuw-opgeslagen", content: SAMPLE.replace("intro", "<div>intro</div>") } });
    await job.run();
    expect(calls).toBe(1);
  });

  test("a text edit during the split: nothing stored, not done and not a failed attempt", async () => {
    await hint(1);
    await noneCell(1);
    let calls = 0;
    const job = createHintSplitJob({
      splitter: splitter(async () => {
        calls++;
        // The organisation edits the text while Gemini works (the sync stores the new text and textChangedAt)
        if (calls === 1) await Article.updateOne({ id: 1 }, { $set: { textHash: "t1-nieuw", textChangedAt: new Date() } });
        return alphaOpen;
      }),
      areas: async () => AREAS,
      maxAttempts: 1,
    });
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect((await HintCell.findOne({ articleId: 1, area: "alpha" }).lean())!.status).toBe(HintCellStatus.None);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBeUndefined();
    // Waiting for the debounce: not picked up yet
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect(calls).toBe(1);
    // Stable again: split (not given up, although maxAttempts is 1)
    await Article.updateOne({ id: 1 }, { $set: { textChangedAt: STABLE } });
    expect((await job.run()).done).toEqual([1]);
    expect((await Article.findOne({ id: 1 }).lean())!.hintSplitHash).toBe(hintSplitKey("t1-nieuw"));
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

  test("a non-retryable failure is tried twice for the same text, then left alone; a text change resets", async () => {
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
    // A markup-only change does not reset
    await Article.updateOne({ id: 1 }, { $set: { contentHash: "nieuw" } });
    await job.run();
    expect(calls).toBe(2);
    await Article.updateOne({ id: 1 }, { $set: { textHash: "nieuw" } });
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
