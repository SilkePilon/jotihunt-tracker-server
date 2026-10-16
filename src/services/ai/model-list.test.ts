import { describe, expect, test } from "bun:test";
import { filterGeminiModels } from "./model-list";

const raw = (name: string, methods = ["generateContent"], displayName = name) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });

describe("filterGeminiModels", () => {
  test("keeps Gemini text models, groups aliases / newest version / older", () => {
    const models = filterGeminiModels([
      raw("gemini-3.5-flash"),
      raw("gemini-3.8-pro"),
      raw("gemini-flash-latest"),
      raw("gemini-3.8-flash"),
      raw("gemini-embedding-001", ["embedContent"]),
      raw("gemini-3.8-flash-image"),
      raw("gemini-3.8-flash-preview-tts"),
      raw("gemini-live-3.8-flash"),
      raw("imagen-4.0-generate"),
      raw("gemma-3-27b-it"),
      raw("aqa", ["generateAnswer"]),
    ]);
    expect(models.map((m) => [m.id, m.group])).toEqual([
      ["gemini-flash-latest", "alias"],
      ["gemini-3.8-flash", "latest"],
      ["gemini-3.8-pro", "latest"],
      ["gemini-3.5-flash", "older"],
    ]);
  });
});
