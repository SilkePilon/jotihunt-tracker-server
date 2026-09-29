import type { PredictionSettingDoc } from "../demo/demo-state";

/** The part of the demo state store this module needs (the `settings` collection of the REAL database). */
export interface PredictionSettingStore {
  readPrediction(): Promise<PredictionSettingDoc | null>;
  writePrediction(setting: Omit<PredictionSettingDoc, "key">): Promise<void>;
}

/** Cached switch: read at startup, updated on write. No document means enabled. */
let enabled = true;
let store: PredictionSettingStore | null = null;

export async function initPredictionSetting(settingStore: PredictionSettingStore): Promise<boolean> {
  store = settingStore;
  enabled = (await settingStore.readPrediction())?.enabled ?? true;
  return enabled;
}

export function isPredictionEnabled(): boolean {
  return enabled;
}

/** Persist first, then update the cache (so a failed write leaves both unchanged). */
export async function setPredictionEnabled(value: boolean, updatedBy: string | null): Promise<boolean> {
  if (!store) throw new Error("Prediction setting is not initialised");
  await store.writePrediction({ enabled: value, updatedAt: new Date(), updatedBy });
  enabled = value;
  return enabled;
}

/** Tests only */
export function resetPredictionSetting() {
  store = null;
  enabled = true;
}
