import type { HuntPhotoSettingDoc } from "../demo/demo-state";

/** The part of the demo state store this module needs (the `settings` collection of the REAL database). */
export interface HuntPhotoSettingStore {
  readHuntPhoto(): Promise<HuntPhotoSettingDoc | null>;
  writeHuntPhoto(setting: Omit<HuntPhotoSettingDoc, "key">): Promise<void>;
}

/**
 * "Foto bij hunt" (Beheer → Algemeen). Off (the default since the rule change of 16 Oct 2026): hunters report a hunt
 * without a photo and confirm it on jotihunt.nl with the fox's QR code. On: the sticker photo flow. Only the clients
 * follow it; the server accepts reports with and without a photo either way. Cached: read at startup, updated on write.
 */
let enabled = false;
let store: HuntPhotoSettingStore | null = null;

export async function initHuntPhotoSetting(settingStore: HuntPhotoSettingStore): Promise<boolean> {
  store = settingStore;
  enabled = (await settingStore.readHuntPhoto())?.enabled ?? false;
  return enabled;
}

export function isHuntPhotoEnabled(): boolean {
  return enabled;
}

/** Persist first, then update the cache (so a failed write leaves both unchanged). */
export async function setHuntPhotoEnabled(value: boolean, updatedBy: string | null): Promise<boolean> {
  if (!store) throw new Error("Hunt photo setting is not initialised");
  await store.writeHuntPhoto({ enabled: value, updatedAt: new Date(), updatedBy });
  enabled = value;
  return enabled;
}

/** Tests only */
export function resetHuntPhotoSetting() {
  store = null;
  enabled = false;
}
