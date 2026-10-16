import type { Connection, Model } from "mongoose";
import { currentGeneration, isDemoMode, runTracked } from "../demo/demo-mode";
import { ServiceError } from "../http/service-error";
import { JOTIBOARD_LINK_KEY, jotiboardLinkModel, type JotiboardLinkDoc } from "../models/jotiboard-link.model";
import { JotiboardAuthError, JotiboardLoginError, JotiboardUpstreamError, type JotiboardApi, type JotiboardSession } from "./jotiboard.client";
import { parseHintSolves, parsePins, type JotiboardConfig } from "./jotiboard.helpers";
import { jotiboardImporter, type JotiboardCounts, type JotiboardImporter } from "./jotiboard.import";
import { decryptSession, encryptSession } from "./session-crypto";
import { errorText } from "../utils/error-text";
import type { ServiceLogger } from "../utils/service-logger";
import { serviceSlot } from "../utils/service-slot";

export interface JotiboardServiceOptions {
  /** null: feature off (no JOTIBOARD_SESSION_KEY), the routes still answer */
  config: JotiboardConfig | null;
  /** Connection to the REAL database (the demo state store's), so the link survives demo mode */
  connection: Connection;
  client: JotiboardApi;
  logger: ServiceLogger;
  /** Default: the real importer (default connection) */
  importer?: JotiboardImporter;
  /** Default 20 s */
  pollIntervalMs?: number;
  /** Default true. Tests set false and call pollOnce() themselves (nextPollAt still says when). */
  autoPoll?: boolean;
  /** Tests only */
  now?: () => Date;
}

export type JotiboardStatus =
  | { state: "unavailable" }
  | { state: "unlinked"; counts: JotiboardCounts }
  | { state: "linked"; username: string; linkedAt: string; syncEnabled: boolean; lastSyncAt: string | null; lastError: string | null; counts: JotiboardCounts }
  | { state: "loggedOut"; username: string; counts: JotiboardCounts };

export const POLL_INTERVAL_MS = 20_000;
/** Refresh the ID token when it has less than this left */
export const REFRESH_MARGIN_MS = 5 * 60_000;

const NOT_CONFIGURED = "Jotiboard is niet ingesteld op de server.";
const NOT_LINKED = "Jotiboard is niet gekoppeld.";
const BUSY = "Even geduld, Jotiboard is nog bezig.";
const UNREACHABLE_LINK = "Jotiboard is nu niet bereikbaar, probeer het later opnieuw.";
const UNREACHABLE_SYNC = "Jotiboard niet bereikbaar, probeert opnieuw";
const SYNC_FAILED = "Synchroniseren mislukt, probeert opnieuw";
const PURGE_IN_DEMO = "Data verwijderen kan niet in demomodus.";
const LOGIN_ERRORS: Record<JotiboardLoginError["code"], [number, string]> = {
  invalid: [400, "Ongeldige gebruikersnaam of wachtwoord"],
  tooMany: [429, "Te veel pogingen, probeer het later opnieuw"],
  disabled: [400, "Dit Jotiboard-account is uitgeschakeld"],
};


interface ActiveLink {
  /** null: the stored token could not be decrypted (key changed) */
  refreshToken: string | null;
  username: string;
  linkedAt: Date;
  syncEnabled: boolean;
  state: "ok" | "reauth";
}

/**
 * Jotiboard → tracker sync: an admin links the Jotiboard account once (only the refresh token is kept, encrypted). While
 * "Automatisch synchroniseren" is on, every 20 s the server reads `manualLocations` and `hintSolves` and the importer
 * writes them into our markers / hint cells. One poller per server process (single replica). Polls are skipped in demo
 * mode (the imports belong to the real game).
 */
export class JotiboardService {
  private readonly links: Model<JotiboardLinkDoc>;
  private readonly importer: JotiboardImporter;
  private active: ActiveLink | null = null;
  private session: JotiboardSession | null = null;
  private lastSyncAt: Date | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAt: Date | null = null;
  /** The running poll, so a purge can wait for it */
  private polling: Promise<void> | null = null;
  /** Bumped on every link change, so a poll of an old link never changes the state */
  private generation = 0;
  private busy = false;
  private stopped = false;

  constructor(private readonly options: JotiboardServiceOptions) {
    this.links = jotiboardLinkModel(options.connection);
    this.importer = options.importer ?? jotiboardImporter;
  }

  get nextPollAt(): Date | null {
    return this.scheduledAt;
  }

  async start(): Promise<void> {
    await this.links.createIndexes();
    const config = this.options.config;
    if (!config) return;
    const doc = await this.links.findOne({ key: JOTIBOARD_LINK_KEY }).lean<JotiboardLinkDoc>();
    if (!doc) return;
    let refreshToken: string | null = null;
    try {
      refreshToken = decryptSession({ ciphertext: doc.refreshCiphertext, iv: doc.iv, tag: doc.tag }, config.sessionKey);
    } catch {
      this.options.logger.error("Could not decrypt the stored Jotiboard session (JOTIBOARD_SESSION_KEY changed?); an admin has to log in again");
    }
    this.active = { refreshToken, username: doc.username, linkedAt: doc.linkedAt, syncEnabled: doc.syncEnabled, state: refreshToken ? doc.state : "reauth" };
    if (this.canPoll()) {
      this.options.logger.info(`Jotiboard link loaded (${doc.username}), syncing`);
      this.schedule(0);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearTimer();
  }

  async status(): Promise<JotiboardStatus> {
    if (!this.options.config) return { state: "unavailable" };
    const counts = await this.importer.counts();
    const link = this.active;
    if (!link) return { state: "unlinked", counts };
    if (link.state === "reauth") return { state: "loggedOut", username: link.username, counts };
    return {
      state: "linked",
      username: link.username,
      linkedAt: link.linkedAt.toISOString(),
      syncEnabled: link.syncEnabled,
      lastSyncAt: this.lastSyncAt?.toISOString() ?? null,
      lastError: this.lastError,
      counts,
    };
  }

  /** Log in with username + password (also "Opnieuw inloggen"); replaces an existing link and turns sync on. */
  async link(username: string, password: string, linkedBy: string | null): Promise<JotiboardStatus> {
    const config = this.requireConfig();
    return this.exclusive(async () => {
      let session: JotiboardSession;
      try {
        session = await this.options.client.signIn(username, password);
      } catch (error) {
        if (error instanceof JotiboardLoginError) {
          const [status, message] = LOGIN_ERRORS[error.code];
          throw new ServiceError(status, message);
        }
        this.options.logger.warn(`Jotiboard login failed: ${errorText(error)}`);
        throw new ServiceError(502, UNREACHABLE_LINK);
      }
      const sealed = encryptSession(session.refreshToken, config.sessionKey);
      const linkedAt = this.now();
      const clean = username.trim().toLowerCase();
      await this.links.updateOne(
        { key: JOTIBOARD_LINK_KEY },
        {
          $set: {
            key: JOTIBOARD_LINK_KEY,
            refreshCiphertext: sealed.ciphertext,
            iv: sealed.iv,
            tag: sealed.tag,
            username: clean,
            uid: session.uid,
            linkedBy,
            linkedAt,
            syncEnabled: true,
            state: "ok",
          },
        },
        { upsert: true },
      );
      this.generation++;
      this.clearTimer();
      this.active = { refreshToken: session.refreshToken, username: clean, linkedAt, syncEnabled: true, state: "ok" };
      this.session = session;
      this.lastSyncAt = null;
      this.lastError = null;
      this.options.logger.info(`Jotiboard linked as ${clean} (${linkedBy ?? "unknown admin"})`);
      this.schedule(0);
      return this.status();
    });
  }

  /** Forget the link (imported data stays). */
  async unlink(): Promise<JotiboardStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      await this.links.deleteOne({ key: JOTIBOARD_LINK_KEY });
      this.generation++;
      this.clearTimer();
      this.active = null;
      this.session = null;
      this.lastSyncAt = null;
      this.lastError = null;
      this.options.logger.info("Jotiboard unlinked");
      return this.status();
    });
  }

  async setSyncEnabled(enabled: boolean): Promise<JotiboardStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      const link = this.active;
      if (!link) throw new ServiceError(409, NOT_LINKED);
      await this.links.updateOne({ key: JOTIBOARD_LINK_KEY }, { $set: { syncEnabled: enabled } });
      link.syncEnabled = enabled;
      if (enabled && this.canPoll()) this.schedule(0);
      if (!enabled) this.clearTimer();
      this.options.logger.info(`Jotiboard sync ${enabled ? "on" : "off"}`);
      return this.status();
    });
  }

  /** "Data verwijderen": turn sync off (else the next poll imports everything again), wait for a running poll, purge. */
  async purge(): Promise<{ removed: { markers: number; hints: number }; status: JotiboardStatus }> {
    this.requireConfig();
    // The imports to remove live in the real database, not in the demo one the default connection serves now
    if (isDemoMode()) throw new ServiceError(409, PURGE_IN_DEMO);
    return this.exclusive(async () => {
      if (this.active) {
        await this.links.updateOne({ key: JOTIBOARD_LINK_KEY }, { $set: { syncEnabled: false } });
        this.active.syncEnabled = false;
      }
      this.clearTimer();
      this.generation++;
      await this.polling;
      const removed = await this.importer.purge();
      this.options.logger.info(`Jotiboard imports removed (${removed.markers} markers, ${removed.hints} hints)`);
      return { removed, status: await this.status() };
    });
  }

  /** One sync; never throws. Called by the timer (and by tests). */
  async pollOnce(): Promise<void> {
    // Wait for a running poll instead of dropping this one: a poll of an old link (re-login while it ran) ends without
    // scheduling, so the poll the new link scheduled must still run. Polls never overlap (the importer has no own guard).
    while (this.polling) await this.polling;
    if (!this.canPoll()) return;
    const run = this.runPoll();
    this.polling = run;
    try {
      await run;
    } finally {
      if (this.polling === run) this.polling = null;
    }
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  private async runPoll(): Promise<void> {
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (isDemoMode()) {
      this.schedule(interval);
      return;
    }
    // The imports must land in the database this poll started in (demo mode may come on while Jotiboard is read)
    const demoGeneration = currentGeneration();
    const generation = this.generation;
    const started = this.now();
    try {
      const idToken = await this.idToken();
      const [solvesRaw, pinsRaw] = await Promise.all([this.options.client.read("hintSolves", idToken), this.options.client.read("manualLocations", idToken)]);
      if (generation !== this.generation) return;
      const ran = await runTracked(
        async () => {
          if (isDemoMode()) return false;
          // Solves first: a hint solution beats a hint pin for the same hour
          await this.importer.importHintSolves(parseHintSolves(solvesRaw));
          await this.importer.importPins(parsePins(pinsRaw));
          return true;
        },
        { generation: demoGeneration },
      );
      if (generation !== this.generation) return;
      if (ran) {
        this.lastSyncAt = started;
        this.lastError = null;
      }
      this.schedule(interval);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof JotiboardAuthError) {
        this.options.logger.warn(`Jotiboard refused the session (${errorText(error)}), an admin has to log in again`);
        if (this.active) this.active.state = "reauth";
        this.session = null;
        this.clearTimer();
        try {
          await this.links.updateOne({ key: JOTIBOARD_LINK_KEY }, { $set: { state: "reauth" } });
        } catch (storeError) {
          this.options.logger.error("Could not store the Jotiboard logged-out state", storeError);
        }
        return;
      }
      this.lastError = error instanceof JotiboardUpstreamError ? UNREACHABLE_SYNC : SYNC_FAILED;
      this.options.logger.warn(`Jotiboard sync failed, retrying in ${Math.round(interval / 1000)} s: ${errorText(error)}`);
      this.schedule(interval);
    }
  }

  /** A valid ID token: the current one, or a fresh one from the refresh token (stored again when it rotated). */
  private async idToken(): Promise<string> {
    const session = this.session;
    if (session && session.expiresAt.getTime() - this.now().getTime() > REFRESH_MARGIN_MS) return session.idToken;
    const link = this.active;
    const refreshToken = link?.refreshToken;
    if (!link || !refreshToken) throw new JotiboardAuthError("No stored Jotiboard session");
    const fresh = await this.options.client.refresh(refreshToken);
    // Re-login or unlink meanwhile: this token belongs to the old link. Otherwise (also after a purge or a sync toggle)
    // keep it: Jotiboard may have rotated the refresh token, and the old one may stop working.
    if (this.active !== link) return fresh.idToken;
    this.session = fresh;
    if (fresh.refreshToken !== refreshToken) {
      link.refreshToken = fresh.refreshToken;
      const sealed = encryptSession(fresh.refreshToken, this.requireConfig().sessionKey);
      // linkedAt: never overwrite the token of a link stored by a re-login that is still finishing
      await this.links.updateOne(
        { key: JOTIBOARD_LINK_KEY, linkedAt: link.linkedAt },
        { $set: { refreshCiphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag } },
      );
    }
    return fresh.idToken;
  }

  private canPoll(): boolean {
    const link = this.active;
    return !this.stopped && !!this.options.config && !!link?.refreshToken && link.syncEnabled && link.state === "ok";
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requireConfig(): JotiboardConfig {
    if (!this.options.config) throw new ServiceError(503, NOT_CONFIGURED);
    return this.options.config;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ServiceError(409, BUSY);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private schedule(delayMs: number) {
    this.clearTimer();
    if (!this.canPoll()) return;
    this.scheduledAt = new Date(this.now().getTime() + delayMs);
    if (this.options.autoPoll === false) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce().catch((error) => this.options.logger.error("Jotiboard poll crashed", error));
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = null;
  }
}

// --- Process instance -----------------------------------------------------------------------------------------------

const slot = serviceSlot<JotiboardService>("Jotiboard is niet ingesteld op de server.");

/** The service of this process; null before startup wiring (index.ts) and in tests that don't set one. */
export const getJotiboardService = slot.get;
export const setJotiboardService = slot.set;
/** The service, or a 503 when none is wired up */
export const requireJotiboardService = slot.require;
