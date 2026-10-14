/**
 * The database can not be reached right now (server down, network, connection pool closed, or mongoose gave up
 * buffering a query while disconnected). Answered with 503 so clients retry instead of treating it as a bug.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/^Mongo(ose)?(ServerSelection|Network|NetworkTimeout|NotConnected|Topology(Closed)?)Error$/.test(error.name)) return true;
  if (error.name === "MongoPoolClearedError" || error.name === "MongoPoolClosedError") return true;
  return /buffering timed out|client was closed|Topology is closed/i.test(error.message);
}
