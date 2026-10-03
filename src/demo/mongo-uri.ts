import type { ConnectOptions } from "mongoose";

const URI_PATTERN = /^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/([^?#]*))?(\?[^#]*)?$/;

interface ParsedMongoUri {
  /** Scheme, credentials and hosts, e.g. "mongodb://user:pass@host:27017" */
  authority: string;
  /** Raw (still percent-encoded) path, "" when absent */
  path: string;
  /** Query string including the "?", "" when absent */
  query: string;
}

function parseMongoUri(uri: string): ParsedMongoUri {
  const match = URI_PATTERN.exec(uri.trim());
  if (!match) throw new Error("Invalid MongoDB connection string");
  return { authority: match[1], path: match[2] ?? "", query: match[3] ?? "" };
}

/** Database name in a MongoDB connection string (the driver's default "test" when it has none). */
export function mongoUriDbName(uri: string): string {
  return decodeURIComponent(parseMongoUri(uri).path) || "test";
}

/** Name of the demo database belonging to a real connection string: `<realDbName>-demo`. */
export function demoDbName(uri: string): string {
  const real = mongoUriDbName(uri);
  const demo = `${real}-demo`;
  if (demo === real) throw new Error("Demo database name equals the real database name");
  return demo;
}

/**
 * Connect options for another database on the same server. The URI stays untouched (it may hold credentials and
 * several hosts); `dbName` selects the database. Without an explicit authSource the driver would authenticate against
 * the selected database, so keep authenticating where the real connection does. `mongodb+srv` URIs are left alone:
 * the driver takes their authSource from the DNS TXT record.
 */
export function demoConnectOptions(uri: string, dbName: string): ConnectOptions {
  const { authority, path, query } = parseMongoUri(uri);
  const isSrv = authority.startsWith("mongodb+srv:");
  const hasCredentials = authority.includes("@");
  const hasAuthSource = /[?&]authSource=/i.test(query);
  const authSource = !isSrv && hasCredentials && !hasAuthSource ? decodeURIComponent(path) || "admin" : undefined;
  return authSource ? { dbName, authSource } : { dbName };
}
