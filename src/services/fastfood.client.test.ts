import { describe, expect, test } from "bun:test";
import { FastfoodUpstreamError, OverpassClient } from "./fastfood.client";
import { OVERPASS_QUERY } from "./fastfood.helpers";

const ELEMENT = { type: "node", id: 1, lat: 52, lon: 5, tags: { "brand:wikidata": "Q38076" } };

function fakeFetch(answers: (Response | Error)[]) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("OverpassClient", () => {
  test("posts the query and returns the elements", async () => {
    const { impl, calls } = fakeFetch([Response.json({ elements: [ELEMENT] })]);
    const client = new OverpassClient(impl, 1000, ["https://a", "https://b"]);
    expect(await client.fetchElements()).toEqual([ELEMENT] as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://a");
    expect(new URLSearchParams(calls[0].body).get("data")).toBe(OVERPASS_QUERY);
  });

  test("falls back to the next endpoint on an error status or network error", async () => {
    const { impl, calls } = fakeFetch([new Response("busy", { status: 429 }), Response.json({ elements: [ELEMENT] })]);
    expect(await new OverpassClient(impl, 1000, ["https://a", "https://b"]).fetchElements()).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual(["https://a", "https://b"]);

    const second = fakeFetch([new Error("ECONNRESET"), Response.json({ elements: [] })]);
    expect(await new OverpassClient(second.impl, 1000, ["https://a", "https://b"]).fetchElements()).toEqual([]);
  });

  test("throws FastfoodUpstreamError when every endpoint fails", async () => {
    const { impl } = fakeFetch([new Response("x", { status: 500 }), new Response("not json", { status: 200 })]);
    await expect(new OverpassClient(impl, 1000, ["https://a", "https://b"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
  });

  test("an answer without elements array is a failure", async () => {
    const { impl } = fakeFetch([Response.json({ remark: "runtime error" })]);
    await expect(new OverpassClient(impl, 1000, ["https://a"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
  });

  test("an answer with an error remark is a partial result and a failure", async () => {
    const { impl } = fakeFetch([
      Response.json({ elements: [ELEMENT], remark: 'runtime error: Query timed out in "query" at line 3 after 91 seconds.' }),
    ]);
    await expect(new OverpassClient(impl, 1000, ["https://a"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
  });

  test("a runtime remark or out-of-memory remark is a partial result and a failure", async () => {
    for (const remark of ["runtime remark: Timed out", "Query run out of memory using about 2048 MB of RAM."]) {
      const { impl } = fakeFetch([Response.json({ elements: [ELEMENT], remark })]);
      await expect(new OverpassClient(impl, 1000, ["https://a"]).fetchElements()).rejects.toBeInstanceOf(FastfoodUpstreamError);
    }
  });

  test("a harmless remark still returns the elements", async () => {
    const { impl } = fakeFetch([Response.json({ elements: [ELEMENT], remark: "note: data may be a few minutes old" })]);
    expect(await new OverpassClient(impl, 1000, ["https://a"]).fetchElements()).toEqual([ELEMENT] as never);
  });
});
