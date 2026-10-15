import { afterEach, describe, expect, test } from "bun:test";
import { localGoogle } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { webTools } from "./web";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function fakeGemini(respond: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const google = localGoogle(async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    bodies.push(body);
    return respond(body);
  });
  stop = google.stop;
  return { tools: webTools({ articleId: 1, now: () => new Date(), toolModel: google.model("gemini-test") }), bodies };
}

const grounded = (text: string, chunks: { uri: string; title?: string }[]) =>
  Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["q"], groundingChunks: chunks.map((web) => ({ web })) } }] });

describe("webSearch", () => {
  test("asks Gemini with Google Search grounding and returns the answer with sources once per URL", async () => {
    const { tools, bodies } = fakeGemini(() =>
      grounded(" Merida is de prinses uit Brave. ", [
        { uri: "https://example.org/brave", title: "example.org" },
        { uri: "https://example.org/brave", title: "example.org" },
        { uri: "https://wiki.example/merida" },
      ]),
    );
    const result = await runTool(tools.webSearch, { query: "wie is Merida" });
    expect(result).toEqual({
      answer: "Merida is de prinses uit Brave.",
      sources: [
        { title: "example.org", url: "https://example.org/brave" },
        { title: "wiki.example", url: "https://wiki.example/merida" },
      ],
    });
    expect(bodies[0].tools).toEqual([{ googleSearch: {} }]);
    expect(JSON.stringify(bodies[0].contents)).toContain("wie is Merida");
  });

  test("a Gemini failure becomes { error } with our Dutch message", async () => {
    const { tools } = fakeGemini(() => Response.json({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }, { status: 503 }));
    expect(await runTool(tools.webSearch, { query: "x" })).toEqual({ error: "Gemini-verzoek mislukt (HTTP 503)" });
  });

  test("an empty query is refused without calling Gemini", async () => {
    const { tools, bodies } = fakeGemini(() => grounded("x", []));
    expect(await runTool(tools.webSearch, { query: "  " })).toEqual({ error: "Zoekvraag moet 1 tot 300 tekens zijn" });
    expect(bodies).toHaveLength(0);
  });
});
