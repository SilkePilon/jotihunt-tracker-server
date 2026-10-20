import mongoose, { type Connection } from "mongoose";
import type { HuntableAreasSettingDoc, NightAreasSettingDoc, PredictionSettingDoc } from "../editions/edition-settings-store";
import type { HuntableAreasStore } from "../settings/huntable-areas-setting";
import type { NightAreasStore } from "../settings/night-areas-setting";
import type { PredictionSettingStore } from "../settings/prediction-setting";

export type TestSettingsStore = PredictionSettingStore &
  HuntableAreasStore &
  NightAreasStore & { connection: Connection; close(): Promise<void> };

/** The per-edition setting documents on a dedicated connection to `uri` (tests of the settings modules). */
export async function openTestSettingsStore(uri: string): Promise<TestSettingsStore> {
  const connection = await mongoose.createConnection(uri).asPromise();
  const settings = () => connection.collection("settings");
  const read = async <T>(key: string) => (await settings().findOne({ key }, { projection: { _id: 0 } })) as T | null;
  const write = async (key: string, value: object) => {
    await settings().updateOne({ key }, { $set: { ...value, key } }, { upsert: true });
  };
  return {
    connection,
    readPrediction: () => read<PredictionSettingDoc>("prediction"),
    writePrediction: (setting) => write("prediction", setting),
    readHuntableAreas: () => read<HuntableAreasSettingDoc>("huntable-areas"),
    writeHuntableAreas: (setting) => write("huntable-areas", setting),
    readNightAreas: () => read<NightAreasSettingDoc>("night-areas"),
    writeNightAreas: (setting) => write("night-areas", setting),
    close: () => connection.close(),
  };
}
