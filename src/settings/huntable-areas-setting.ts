import { AREAS, type AreaName } from "../constants/areas";
import type { HuntableAreasSettingDoc } from "../demo/demo-state";

/** The part of the demo state store this module needs (the `settings` collection of the REAL database). */
export interface HuntableAreasStore {
  readHuntableAreas(): Promise<HuntableAreasSettingDoc | null>;
  writeHuntableAreas(setting: Omit<HuntableAreasSettingDoc, "key">): Promise<void>;
}

/** Cached list: read at startup, updated on write. Null (no document) means not configured: every fox may be hunted. */
let areas: AreaName[] | null = null;
let store: HuntableAreasStore | null = null;

/** Known areas only, without duplicates, sorted (AREAS is alphabetical). */
export function normalizeAreas(list: readonly string[]): AreaName[] {
  return AREAS.filter((area) => list.includes(area));
}

export async function initHuntableAreas(settingStore: HuntableAreasStore): Promise<AreaName[] | null> {
  store = settingStore;
  const doc = await settingStore.readHuntableAreas();
  areas = doc ? normalizeAreas(doc.areas ?? []) : null;
  return areas;
}

/** Areas we may hunt besides our own; null when an admin never set them. */
export function getHuntableAreas(): AreaName[] | null {
  return areas;
}

/** Persist first, then update the cache (so a failed write leaves both unchanged). */
export async function setHuntableAreas(list: readonly string[], updatedBy: string | null): Promise<AreaName[]> {
  if (!store) throw new Error("Huntable areas setting is not initialised");
  const next = normalizeAreas(list);
  await store.writeHuntableAreas({ areas: next, updatedAt: new Date(), updatedBy });
  areas = next;
  return next;
}

/** Tests only */
export function resetHuntableAreas() {
  store = null;
  areas = null;
}
