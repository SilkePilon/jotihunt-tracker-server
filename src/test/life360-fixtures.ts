/** A fix time for the Life360 tests: Unix seconds, as Life360 sends it */
export const FIX_TIME = 1792065600;
export const FIX_ISO = "2026-10-15T12:00:00.000Z";

export interface RawMemberOptions {
  /** Overrides of location fields; null: no location at all */
  location?: Record<string, unknown> | null;
  shareLocation?: string;
  /** undefined: a life360.com avatar URL; null: no avatar */
  avatar?: string | null;
}

/**
 * One member of GET /v3/circles/{cid}/members with every key the real test login saw (2026-10-13), values as strings like
 * Life360 sends them. Includes an address, place name, e-mail and phone so tests can prove they never come out.
 */
export function rawMember(id: string, firstName: string, lastName: string, options: RawMemberOptions = {}): Record<string, unknown> {
  return {
    id,
    firstName,
    lastName,
    avatar: options.avatar === undefined ? `https://www.life360.com/img/user_images/${id}.jpg` : options.avatar,
    loginEmail: `${firstName.toLowerCase() || "x"}@example.nl`,
    loginPhone: "+31612345678",
    createdAt: "1700000000",
    isAdmin: "0",
    pinNumber: null,
    features: { shareLocation: options.shareLocation ?? "1", disconnected: "0" },
    issues: { title: null, dialog: null },
    location:
      options.location === null
        ? null
        : {
            latitude: "52.0907",
            longitude: "5.1214",
            accuracy: "50.0",
            startTimestamp: String(FIX_TIME - 600),
            endTimestamp: String(FIX_TIME),
            since: String(FIX_TIME - 3600),
            timestamp: String(FIX_TIME),
            name: "Thuis",
            placeType: null,
            source: null,
            sourceId: null,
            address1: "Dorpsstraat 1",
            address2: "Scherpenzeel",
            shortAddress: "Dorpsstraat 1, Scherpenzeel",
            inTransit: "0",
            tripId: null,
            driveSDKStatus: null,
            battery: "84",
            charge: "0",
            wifiState: "1",
            speed: "0.05",
            isDriving: "0",
            userActivity: "unknown",
            algorithm: null,
            ...options.location,
          },
    communications: [{ channel: "Email", value: "x@example.nl" }],
    activity: null,
    relation: null,
    medical: null,
  };
}
