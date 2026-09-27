import mongoose from "mongoose";

/**
 * Connect to the test database (MONGO_URI_TEST) and make sure all model indexes exist.
 * Import the models under test before calling this.
 */
export async function connectTestDb() {
  const uri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

export async function clearTestDb() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
