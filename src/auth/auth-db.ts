import mongoose, { type Connection, type Model, type Schema } from "mongoose";

/**
 * Auth data (sessions, invites, herstel-links, challenges) lives in the REAL database, on the demo state store's
 * connection, so switching demo mode never logs anyone out. Tests and scripts leave it unset: the default connection.
 */
let real: Connection | null = null;

export function setAuthConnection(connection: Connection | null) {
  real = connection;
}

export function authConnection(): Connection {
  return real ?? mongoose.connection;
}

/** The model `name` on the auth connection, compiled on first use. */
export function authModel<T>(name: string, schema: Schema<T>): Model<T> {
  const connection = authConnection();
  return (connection.models[name] as Model<T> | undefined) ?? connection.model<T>(name, schema);
}
