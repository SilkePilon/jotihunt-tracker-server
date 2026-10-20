import { createHash } from "node:crypto";
import type { NightAreasSettingDoc } from "../editions/edition-settings-store";
import type { NightArea } from "../services/routes/graphhopper.client";

export interface NightAreasStore {
  readNightAreas(): Promise<NightAreasSettingDoc | null>;
  writeNightAreas(setting: Omit<NightAreasSettingDoc, "key">): Promise<void>;
}
export interface RoutesSetting { enabled: boolean; areas: NightArea[] }

const DEFAULT: RoutesSetting = { enabled: true, areas: [] };
let current: RoutesSetting = DEFAULT;
let store: NightAreasStore | null = null;
const listeners = new Set<() => void>();

export async function initNightAreas(settingStore: NightAreasStore): Promise<RoutesSetting> {
  store = settingStore;
  const doc = await settingStore.readNightAreas();
  current = doc ? { enabled: doc.enabled !== false, areas: doc.areas ?? [] } : DEFAULT;
  return current;
}

export function getRoutesSetting(): RoutesSetting {
  return current;
}

/** Persist first, then update the cache. */
export async function setRoutesSetting(next: RoutesSetting, updatedBy: string | null): Promise<RoutesSetting> {
  if (!store) throw new Error("Night areas setting is not initialised");
  const clean: RoutesSetting = { enabled: next.enabled, areas: next.areas.map(({ id, name, kind, polygon }) => ({ id, name, kind, polygon })) };
  await store.writeNightAreas({ ...clean, updatedAt: new Date(), updatedBy });
  current = clean;
  for (const listener of listeners) listener();
  return clean;
}

/** Changes whenever the admin areas change; part of the night route cache key. */
export function nightAreasHash(): string {
  return current.areas.length ? createHash("sha1").update(JSON.stringify(current.areas)).digest("hex").slice(0, 16) : "";
}

/** Called after every change (the trails service drops its memo). */
export function onRoutesSettingChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only */
export function resetNightAreas() {
  store = null;
  current = DEFAULT;
  listeners.clear();
}
