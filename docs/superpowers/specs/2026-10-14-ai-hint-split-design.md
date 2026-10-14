# AI hint split — design

Date: 2026-10-14. Follows the intel window (client spec `2026-10-14-intel-window-design.md`).

## Problem

`parseHintArticle` (`src/services/hint-parser.ts`) splits a hint article into per-area parts with a regex on
"Alpha: …" labels. An area becomes "geen hint" (status `none`) when its part is only a dash, or stays without a snippet
when the label isn't found. Unusual layouts (labels in images, tables, "Alpha en Bravo:", typos) give wrong results,
and since the intel window only lets you answer open areas, a wrongly-none area could not be solved.

## Decisions (user, 2026-10-14)

- **Rule first, AI checks:** cells are still created right away by the regex (no waiting at hint time). A background
  job then lets Gemini split the article and corrects per area the status (open / none) and the snippet.
- **Safety net in the UI:** a "geen hint" row stays dimmed but can be unfolded and answered.

## Server

- **Blocks:** the article HTML is cut into numbered blocks at block boundaries (`<br>`, `</p>`, `</div>`, `</li>`,
  `</figure>`, `<hr>`, headings; empty blocks dropped). Each block keeps its original HTML.
- **Gemini call** (`createHintSplitter({ model })`, model purpose `summary`, structured output, temperature 0.1,
  timeout 30 s, no SDK retries): the prompt explains Jotihunt hints (shared intro + one encoded part per deelgebied,
  "-" = no hint for that team, areas Alpha…Hotel + Oscar), lists the blocks as `[n] <plain text; images as
  [afbeelding: alt/src filename]>`, and asks for `{ areas: [{ area, none: boolean, blocks: number[] }] }`.
- **Clean answer:** unknown areas and out-of-range / duplicate block numbers are dropped; an area missing from the
  answer is "unknown" (left as the rule made it); `none: true` with blocks → treated as not none. An answer with no
  usable area is invalid (GeminiError, counts as a failed attempt).
- **Snippet** for an area = the original HTML of its blocks joined in order (never AI-written HTML).
- **Job** (`createHintSplitJob`, cron `15,35,55 * * * * *`, one article per run): picks hint articles whose
  `hintSplitHash !== contentHash` (new field on Article, like `summaryHash`), newest first. Same pause/backoff and
  give-up rules as the summary job (retryable → pause 2 min doubling to 15; other failures count, give up after 2 for
  the same content), runs inside `runTracked` with the generation check, Gemini call outside it.
- **Apply** (`applyHintSplit(article, split)`): per area with an AI result, update the cell only if its status is `open`
  or `none` (never `solved`): `status` = none ? `none` : `open`, `snippet` = joined blocks (unset when none and no
  blocks). Compare-and-set on the cell's current status so a solve that lands meanwhile wins. Then set
  `hintSplitHash = contentHash` (only if the content is unchanged) and `invalidateBoardCache()` when something changed.
- No `GEMINI_API_KEY` → no job; the rule result stays. Startup warning text gains "hints are split by rule only".
- Logging like the summaries cron: `(CRON) Split hint articles …`, warnings for Gemini failures.

## Client

- `HintPane`: a `none` row keeps its dimmed look ("geen hint") but becomes a normal expandable row (chevron). Its
  body shows a muted line `Volgens de hint geen opdracht voor {Area} deze ronde.`, the area's snippet (if any) and the
  usual answer field + preview. Saving works as for open rows (server accepts it); the row then shows as solved.
- `initialOpenArea` / `nextOpenArea` keep skipping `none` areas (they only auto-open real open areas).
- Rows without a cell (missing) stay non-interactive.

## Testing

- Server unit tests: block cutting (br/p/div/li/img cases, empty blocks), snippet join, answer cleaning, prompt
  contains the blocks and areas, apply never touches solved cells and respects a concurrent solve, re-split after a
  content change (hash), job pause/give-up (mock model like the summary tests).
- Client: `HintPane` none rows expandable (bun test for any extracted helper), build/lint/tests.
- One real Gemini run against a sample hint with the cluster key (manual, read-only on a throwaway DB).
