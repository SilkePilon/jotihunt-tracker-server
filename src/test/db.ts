import mongoose from "mongoose";

/**
 * Connect to the test database (MONGO_URI_TEST), empty it and make sure all model indexes exist (and no stale ones).
 * Import the models under test before calling this.
 *
 * The collections are emptied, not dropped: building an index on a fresh collection costs ~0.1 s on the test Mongo,
 * and a full run registers every model in one process, so dropping the database made every test file rebuild all
 * indexes (3-5 s, right at bun's 5 s hook timeout). syncIndexes on existing indexes takes milliseconds.
 */
export async function connectTestDb() {
  const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray();
  await Promise.all(collections.filter(({ name }) => !name.startsWith("system.")).map(({ name }) => db.collection(name).deleteMany({})));
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

export async function clearTestDb() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
