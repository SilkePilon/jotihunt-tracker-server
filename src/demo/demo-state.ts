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
  close(): Promise<void>;
}

export async function openDemoStateStore(realUri: string, options: mongoose.ConnectOptions = {}): Promise<DemoStateStore> {
  const connection = await mongoose.createConnection(realUri, options).asPromise();
  const DemoState: Model<DemoStateDoc> = connection.model<DemoStateDoc>("DemoState", DemoStateSchema);
  const PredictionSetting: Model<PredictionSettingDoc> = connection.model<PredictionSettingDoc>("PredictionSetting", PredictionSettingSchema);
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
    async close() {
      await connection.close();
    },
  };
}
