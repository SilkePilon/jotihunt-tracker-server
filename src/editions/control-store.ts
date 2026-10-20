import mongoose, { type Connection } from "mongoose";
import { EDITIONS_KEY, type EditionsDoc } from "./registry";

/**
 * Dedicated connection to the control database (the one in MONGO_URI): the edition registry, app-config, auth and the
 * shared caches. Stays put whichever edition the default Mongoose connection serves.
 */
export interface ControlStore {
  connection: Connection;
  readRegistry(): Promise<EditionsDoc | null>;
  writeRegistry(doc: EditionsDoc): Promise<void>;
  /** Removes the old demo switch document; returns whether one existed */
  deleteDemoDoc(): Promise<boolean>;
  close(): Promise<void>;
}

export async function openControlStore(uri: string, options: mongoose.ConnectOptions = {}): Promise<ControlStore> {
  const connection = await mongoose.createConnection(uri, options).asPromise();
  const settings = () => connection.collection("settings");
  return {
    connection,
    async readRegistry() {
      return (await settings().findOne({ key: EDITIONS_KEY }, { projection: { _id: 0 } })) as EditionsDoc | null;
    },
    async writeRegistry(doc) {
      await settings().replaceOne({ key: EDITIONS_KEY }, { ...doc, key: EDITIONS_KEY }, { upsert: true });
    },
    async deleteDemoDoc() {
      return (await settings().deleteOne({ key: "demo" })).deletedCount > 0;
    },
    async close() {
      await connection.close();
    },
  };
}
