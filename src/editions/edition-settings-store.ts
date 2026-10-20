import mongoose from "mongoose";
import type { NightArea } from "../services/routes/graphhopper.client";
import { initHuntableAreas, type HuntableAreasStore } from "../settings/huntable-areas-setting";
import { initNightAreas, type NightAreasStore } from "../settings/night-areas-setting";
import { initPredictionSetting, type PredictionSettingStore } from "../settings/prediction-setting";

/** Global AI fox prediction switch; one document (key "prediction") in the `settings` collection. */
export interface PredictionSettingDoc {
  key: string;
  enabled: boolean;
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

/** Fox teams we may hunt besides our own (rule 5.1); one document (key "huntable-areas") in the `settings` collection. */
export interface HuntableAreasSettingDoc {
  key: string;
  /** Lowercase area names, sorted, without duplicates */
  areas: string[];
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

/** Routed trails: on/off + admin night areas; one document (key "night-areas") in the `settings` collection. */
export interface NightAreasSettingDoc {
  key: string;
  enabled: boolean;
  areas: NightArea[];
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

/**
 * Settings that belong to one Jotihunt (prediction switch, huntable areas, night areas) in the `settings` collection of
 * the shown edition's database. Resolved on every call, so it follows edition switches.
 */
export function editionSettingsStore(): PredictionSettingStore & HuntableAreasStore & NightAreasStore {
  const settings = () => mongoose.connection.collection("settings");
  const read = async <T>(key: string) => (await settings().findOne({ key }, { projection: { _id: 0 } })) as T | null;
  const write = async (key: string, value: object) => {
    await settings().updateOne({ key }, { $set: { ...value, key } }, { upsert: true });
  };
  return {
    readPrediction: () => read<PredictionSettingDoc>("prediction"),
    writePrediction: (setting) => write("prediction", setting),
    readHuntableAreas: () => read<HuntableAreasSettingDoc>("huntable-areas"),
    writeHuntableAreas: (setting) => write("huntable-areas", setting),
    readNightAreas: () => read<NightAreasSettingDoc>("night-areas"),
    writeNightAreas: (setting) => write("night-areas", setting),
  };
}

/** (Re)load the per-edition setting caches from the shown edition. */
export async function initEditionSettings(): Promise<void> {
  const store = editionSettingsStore();
  await initPredictionSetting(store);
  await initHuntableAreas(store);
  await initNightAreas(store);
}
