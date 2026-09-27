/** Distance from a group that counts as "at the group". */
export const VISIT_RADIUS_M = 300;
/** Heading is only used when the last two observations are at least this far apart… */
export const HEADING_MIN_DISTANCE_M = 200;
/** …and at most this many minutes apart. */
export const HEADING_MAX_GAP_MIN = 180;
export const CLUSTER_RADIUS_M = 1500;
export const SOFTMAX_TEMPERATURE = 0.15;
export const TOP_CANDIDATES = 3;
export const ELAPSED_CAP_MIN = 120;
/** ORS foot-walking speed (5 km/h) in metres per minute. */
export const WALK_M_PER_MIN = 5000 / 60;
/** Straight-line distance × this factor approximates the walking distance. */
export const DETOUR_FACTOR = 1.3;
export const STOP_RADIUS_M = 250;
/** The last group of a round may only start the next round this many minutes later. */
export const REPEAT_EXCLUSION_MIN = 30;
export const EMA_ALPHA = 0.3;
export const WEIGHT_STEP = 0.1;
export const SPEED_FACTOR_RANGE: [number, number] = [0.5, 1.6];
export const DWELL_RANGE: [number, number] = [0, 45];
export const WEIGHT_RANGE: [number, number] = [0, 2];
export const MAX_ISLANDS = 3;
export const TRANSIT_CACHE_MS = 30 * 60 * 1000;
export const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;
/** After a RoutingUnavailableError, ORS is treated as down for this long before being retried. */
export const ORS_COOLDOWN_MS = 5 * 60 * 1000;
/** A request ORS rejected as unanswerable (400/404) is answered from the cached fallback for this long. */
export const ORS_REQUEST_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
/** After a TransitUnavailableError, Transitous is skipped (walking only) for this long. */
export const TRANSIT_COOLDOWN_MS = 5 * 60 * 1000;
export const USER_AGENT = "jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)";
