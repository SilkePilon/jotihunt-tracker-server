import mongoose, { type Connection, type Model } from "mongoose";

/** Persisted demo mode switch; one document (key "demo") in the `settings` collection of the REAL database. */
export interface DemoStateDoc {
  key: string;
  enabled: boolean;
  enabledAt?: Date | null;
  enabledBy?: string | null;
  /** When the current demo world was generated */
  startedAt?: Date | null;
}

const DemoStateSchema = new mongoose.Schema<DemoStateDoc>(
  {
    key: { type: String, required: true, unique: true },
    enabled: { type: Boolean, required: true, default: false },
    enabledAt: { type: Date, default: null },
    enabledBy: { type: String, default: null },
    startedAt: { type: Date, default: null },
  },
  { collection: "settings", versionKey: false },
);

const KEY = "demo";

/** Global AI fox prediction switch; one document (key "prediction") in the same `settings` collection. */
export interface PredictionSettingDoc {
  key: string;
  enabled: boolean;
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

const PredictionSettingSchema = new mongoose.Schema<PredictionSettingDoc>(
  {
    key: { type: String, required: true, unique: true },
    enabled: { type: Boolean, required: true, default: true },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { collection: "settings", versionKey: false },
);

const PREDICTION_KEY = "prediction";

/** Fox teams we may hunt besides our own (rule 5.1); one document (key "huntable-areas") in the same `settings` collection. */
export interface HuntableAreasSettingDoc {
  key: string;
  /** Lowercase area names, sorted, without duplicates */
  areas: string[];
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

const HuntableAreasSettingSchema = new mongoose.Schema<HuntableAreasSettingDoc>(
  {
    key: { type: String, required: true, unique: true },
    areas: { type: [String], required: true, default: [] },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { collection: "settings", versionKey: false },
);

const HUNTABLE_AREAS_KEY = "huntable-areas";


/**
 * Store for the DemoState document on a dedicated connection to the real database, so it stays reachable whichever
 * database the default Mongoose connection currently points to. Not registered in `mongoose.models`.
 */
export interface DemoStateStore {
  connection: Connection;
  read(): Promise<DemoStateDoc | null>;
  write(state: Omit<DemoStateDoc, "key">): Promise<void>;
  readPrediction(): Promise<PredictionSettingDoc | null>;
  writePrediction(setting: Omit<PredictionSettingDoc, "key">): Promise<void>;
  readHuntableAreas(): Promise<HuntableAreasSettingDoc | null>;
  writeHuntableAreas(setting: Omit<HuntableAreasSettingDoc, "key">): Promise<void>;
  close(): Promise<void>;
}

export async function openDemoStateStore(realUri: string, options: mongoose.ConnectOptions = {}): Promise<DemoStateStore> {
  const connection = await mongoose.createConnection(realUri, options).asPromise();
  const DemoState: Model<DemoStateDoc> = connection.model<DemoStateDoc>("DemoState", DemoStateSchema);
  const PredictionSetting: Model<PredictionSettingDoc> = connection.model<PredictionSettingDoc>("PredictionSetting", PredictionSettingSchema);
  const HuntableAreasSetting: Model<HuntableAreasSettingDoc> = connection.model<HuntableAreasSettingDoc>("HuntableAreasSetting", HuntableAreasSettingSchema);
  return {
    connection,
    async read() {
      return DemoState.findOne({ key: KEY }).lean<DemoStateDoc>();
    },
    async write(state) {
      await DemoState.updateOne({ key: KEY }, { $set: { ...state, key: KEY } }, { upsert: true });
    },
    async readPrediction() {
      return PredictionSetting.findOne({ key: PREDICTION_KEY }).lean<PredictionSettingDoc>();
    },
    async writePrediction(setting) {
      await PredictionSetting.updateOne({ key: PREDICTION_KEY }, { $set: { ...setting, key: PREDICTION_KEY } }, { upsert: true });
    },
    async readHuntableAreas() {
      return HuntableAreasSetting.findOne({ key: HUNTABLE_AREAS_KEY }).lean<HuntableAreasSettingDoc>();
    },
    async writeHuntableAreas(setting) {
      await HuntableAreasSetting.updateOne({ key: HUNTABLE_AREAS_KEY }, { $set: { ...setting, key: HUNTABLE_AREAS_KEY } }, { upsert: true });
    },
    async close() {
      await connection.close();
    },
  };
}
