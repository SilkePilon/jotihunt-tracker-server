/** ORS foot-walking speed (5 km/h) in metres per minute. */
export const WALK_M_PER_MIN = 5000 / 60;
/** Straight-line distance × this factor approximates the walking distance. */
export const DETOUR_FACTOR = 1.3;
export const TOP_CANDIDATES = 3;
/** A prediction older than this is recomputed even without new inputs. */
export const RECOMPUTE_INTERVAL_MS = 10 * 60 * 1000;
/** After a failed Gemini run, the area waits this long before trying again. */
export const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
/** Wait before the single retry of a failed Gemini answer. */
export const RETRY_DELAY_MS = 3000;
/** A pin further than this from the last trail point is rejected. */
export const MAX_PIN_DISTANCE_M = 15_000;
/** Reasoning shown behind the ⓘ is cut to this many characters. */
export const MAX_WHY_LENGTH = 120;
/** ETAs further than this ahead are clamped. */
export const MAX_ETA_MINUTES = 600;
/** After a RoutingUnavailableError, ORS is treated as down for this long before being retried. */
export const ORS_COOLDOWN_MS = 5 * 60 * 1000;
/** A request ORS rejected as unanswerable (400/404) is answered from the cached fallback for this long. */
export const ORS_REQUEST_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
export const USER_AGENT = "jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)";
