/** How long a user stays listed after their last heartbeat (the client beats every 10 s) */
export const PRESENCE_TTL_MS = 25_000;

export interface PresenceEntry {
  userId: string;
  name: string;
  itemId: number;
  area?: string;
  /** Time of the last heartbeat (ms since epoch) */
  at: number;
}

export interface Presence {
  /** The user has this item (and for a hint, this area) open right now */
  beat(user: { _id: string; name: string }, itemId: number, area?: string): void;
  leave(userId: string): void;
  list(): PresenceEntry[];
}

/**
 * Who has which item of the hints page open. In memory only: one entry per user, gone 25 s after the last
 * heartbeat, empty after a restart (and filled again within one heartbeat).
 */
export function createPresence({ ttlMs = PRESENCE_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): Presence {
  const entries = new Map<string, PresenceEntry>();

  function prune() {
    const oldest = now() - ttlMs;
    for (const [userId, entry] of entries) if (entry.at <= oldest) entries.delete(userId);
  }

  return {
    beat(user, itemId, area) {
      entries.set(user._id, { userId: user._id, name: user.name, itemId, area, at: now() });
    },
    leave(userId) {
      entries.delete(userId);
    },
    list() {
      prune();
      return [...entries.values()];
    },
  };
}

/** The presence of the running server */
export const presence = createPresence();
