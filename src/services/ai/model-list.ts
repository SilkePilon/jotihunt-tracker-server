import { ServiceError } from "../../http/service-error";
import { secret } from "../../settings/app-config";

export interface RawModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  group: "alias" | "latest" | "older";
}

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CACHE_MS = 10 * 60 * 1000;
/** Not for text: embeddings, image/audio generation, live/TTS */
const NOT_TEXT = /embedding|imagen|tts|image|live|audio/;

const versionOf = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? NaN);

/** Gemini models that answer generateContent with text, aliases first, then newest version first. */
export function filterGeminiModels(raw: RawModel[]): GeminiModelInfo[] {
  const text = raw
    .map((model) => ({ id: model.name.replace(/^models\//, ""), displayName: model.displayName ?? model.name, methods: model.supportedGenerationMethods ?? [] }))
    .filter((model) => model.id.startsWith("gemini-") && model.methods.includes("generateContent") && !NOT_TEXT.test(model.id));
  const newest = Math.max(...text.map((model) => versionOf(model.id)).filter((v) => !Number.isNaN(v)));
  const group = (id: string): GeminiModelInfo["group"] => (id.endsWith("-latest") ? "alias" : versionOf(id) === newest ? "latest" : "older");
  const order = { alias: 0, latest: 1, older: 2 } as const;
  return text
    .map((model) => ({ id: model.id, displayName: model.displayName, group: group(model.id) }))
    .sort((a, b) => order[a.group] - order[b.group] || (versionOf(b.id) || 0) - (versionOf(a.id) || 0) || a.id.localeCompare(b.id));
}

let cache: { apiKey: string; at: number; models: GeminiModelInfo[] } | null = null;

/** Tests only */
export function resetModelListCache() {
  cache = null;
}

export async function listGeminiModels(options: { refresh?: boolean; fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<{ models: GeminiModelInfo[]; fetchedAt: string }> {
  const apiKey = secret("geminiApiKey");
  if (!apiKey) throw new ServiceError(409, "Geen Gemini-sleutel ingesteld.");
  if (!options.refresh && cache && cache.apiKey === apiKey && Date.now() - cache.at < CACHE_MS) {
    return { models: cache.models, fetchedAt: new Date(cache.at).toISOString() };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  // The key goes in a header, never in the URL (URLs end up in logs)
  const response = await fetchImpl(`${options.baseUrl ?? GOOGLE_BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response) throw new ServiceError(502, "Modellijst van Google niet bereikbaar.");
  if (response.status === 400 || response.status === 403) throw new ServiceError(400, "Google weigert de Gemini-sleutel.", { code: "key_rejected" });
  if (!response.ok) throw new ServiceError(502, "Modellijst van Google niet bereikbaar.");
  const body = (await response.json().catch(() => null)) as { models?: RawModel[] } | null;
  if (!body) throw new ServiceError(502, "Modellijst van Google niet bereikbaar.");
  const models = filterGeminiModels(body.models ?? []);
  cache = { apiKey, at: Date.now(), models };
  return { models, fetchedAt: new Date(cache.at).toISOString() };
}
