import { randomUUID } from "node:crypto";
import type { Connection, Model } from "mongoose";
import { ServiceError } from "../http/service-error";
import { LIFE360_LINK_KEY, life360LinkModel, type Life360LinkDoc } from "../models/life360-link.model";
import { Life360BlockedError, Life360CodeInvalidError, Life360NotFoundError, Life360RateLimitedError, Life360UnauthorizedError, Life360UpstreamError, type Life360Api } from "./life360.client";
import { liveCount, parseMembers, type Life360AdminStatus, type Life360Circle, type Life360Config, type Life360Member, type Life360Members } from "./life360.helpers";
import { decryptSession, encryptSession } from "./telegram.helpers";

export interface Life360Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface Life360ServiceOptions {
  /** null: feature off (no LIFE360_SESSION_KEY), the routes still answer */
  config: Life360Config | null;
  /** Connection to the REAL database (the demo state store's), so the link survives demo mode */
  connection: Connection;
  client: Life360Api;
  logger: Life360Logger;
  /** Default 30 s */
  pollIntervalMs?: number;
  /** Default true. Tests set false and call pollOnce() themselves (the next poll time is still kept in nextPollAt). */
  autoPoll?: boolean;
  /** Tests only */
  now?: () => Date;
}

export const POLL_INTERVAL_MS = 30_000;
/** A new e-mail code at most once per minute (Cloudflare blocks ~3 sends per 10 s for minutes) */
export const RESEND_MS = 60_000;
/** After Life360 refused a send with 429/403: wait at least this long */
const SEND_BLOCK_MIN_MS = 2 * 60_000;
/** A pending login (waiting for the code) is dropped this long after the code was sent */
export const PENDING_CODE_MS = 10 * 60_000;
export const REFRESH_COOLDOWN_MS = 60_000;
/** 429 while polling: pause at least this long, longer when Retry-After says so */
export const PAUSE_MIN_MS = 5 * 60_000;
/** 403 while polling (Cloudflare): pause this long */
export const BLOCKED_PAUSE_MS = 5 * 60_000;
export const BACKOFF_INITIAL_MS = 30_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** A members call without if-none-match at least this often: some accounts get endless 304s (ha-life360 #98) */
export const FULL_POLL_MS = 5 * 60_000;
export const AVATAR_CACHE_MS = 60 * 60_000;
/** A failed avatar fetch is not retried for this long */
export const AVATAR_FAILURE_MS = 5 * 60_000;

const NOT_CONFIGURED = "Life360 is niet ingesteld op de server.";
const UNREACHABLE = "Life360 is nu niet bereikbaar, probeer het later opnieuw.";
const SEND_WAIT = "Even wachten, je kunt zo weer een code sturen.";
const LIMITED = "Life360 laat even geen verzoeken toe, probeer het over een paar minuten opnieuw.";
const BUSY = "Even geduld, Life360 is nog bezig.";
const NO_AVATAR = "Geen foto.";
const AVATAR_UNAVAILABLE = "Foto niet beschikbaar.";

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PendingCode {
  email: string;
  transactionId: string;
  deviceId: string;
  resendAt: Date;
  /** The login is dropped after this (PENDING_CODE_MS after the code was sent) */
  expiresAt: Date;
}

interface ChoosingCircle {
  email: string;
  token: string;
  deviceId: string;
  circles: Life360Circle[];
}

interface ActiveLink {
  /** null: the stored token could not be decrypted (LIFE360_SESSION_KEY changed) */
  token: string | null;
  email: string;
  deviceId: string;
  circleId: string;
  circleName: string;
}

interface CachedAvatar {
  source: string;
  contentType: string;
  body: Buffer;
  fetchedAt: number;
}

/**
 * The team's Life360 circle: an admin links a (dedicated) Life360 account by e-mail code, the server polls the circle's
 * members every 30 s (one call, if-none-match) and keeps the latest members in memory only. One poller per server process
 * (the server runs as a single replica).
 *
 * States: unavailable (no key) · unlinked · code (waiting for the 6 digits) · circle (pick one of several) · linked ·
 * loggedOut (Life360 answered 401; polling stops, the last members stay, shown stale) · paused (429/403 until retryAt).
 */
export class Life360Service {
  private readonly links: Model<Life360LinkDoc>;
  /** x-device-id for a login without a stored link (then stored with the link and reused) */
  private readonly processDeviceId = randomUUID().toUpperCase();
  private pending: PendingCode | null = null;
  private choosing: ChoosingCircle | null = null;
  private link: ActiveLink | null = null;
  private phase: "linked" | "loggedOut" | "paused" = "linked";
  private retryAt: Date | null = null;
  private memberList: Life360Member[] = [];
  private avatarSources = new Map<string, string>();
  private readonly avatarCache = new Map<string, CachedAvatar>();
  /** Failed fetches by member id (not retried until `until`) */
  private readonly avatarFailures = new Map<string, { source: string; status: 404 | 502; until: number }>();
  /** The running fetch by member id, shared by concurrent requests */
  private readonly avatarFetches = new Map<string, { source: string; promise: Promise<CachedAvatar | 404 | 502> }>();
  private etag: string | null = null;
  private lastPollAt: Date | null = null;
  private lastFullPollAt: Date | null = null;
  private nextSendAt: Date | null = null;
  private refreshAvailableAt: Date | null = null;
  private backoffMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAt: Date | null = null;
  /** Bumped on every link/unlink, so a poll of an old link never changes the state */
  private generation = 0;
  private busy = false;
  private stopped = false;

  constructor(private readonly options: Life360ServiceOptions) {
    this.links = life360LinkModel(options.connection);
  }

  get available(): boolean {
    return this.options.config !== null;
  }

  /** When the next members call is due (null: not polling). */
  get nextPollAt(): Date | null {
    return this.scheduledAt;
  }

  /** Build the index and, when a link is stored, resume polling (in the background). */
  async start(): Promise<void> {
    await this.links.createIndexes();
    const config = this.options.config;
    if (!config) return;
    const doc = await this.links.findOne({ key: LIFE360_LINK_KEY }).lean<Life360LinkDoc>();
    if (!doc) return;
    let token: string | null = null;
    try {
      token = decryptSession({ ciphertext: doc.tokenCiphertext, iv: doc.iv, tag: doc.tag }, config.sessionKey);
    } catch {
      this.options.logger.error("Could not decrypt the stored Life360 token (LIFE360_SESSION_KEY changed?); an admin has to log in to Life360 again");
    }
    this.link = { token, email: doc.email, deviceId: doc.deviceId, circleId: doc.circleId, circleName: doc.circleName };
    this.phase = token ? "linked" : "loggedOut";
    if (!token) return;
    this.options.logger.info(`Life360 link loaded (circle ${doc.circleName}), polling`);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // A poll or refresh still running drops its result
    this.generation++;
    this.clearTimer();
  }

  status(): Life360AdminStatus {
    if (!this.options.config) return { state: "unavailable" };
    const pending = this.currentPending();
    if (pending) return { state: "code", email: pending.email, resendAt: pending.resendAt.toISOString() };
    if (this.choosing) return { state: "circle", email: this.choosing.email, circles: this.choosing.circles.map(({ id, name }) => ({ id, name })) };
    const link = this.link;
    if (!link) return { state: "unlinked" };
    if (this.phase === "loggedOut") return { state: "loggedOut", email: link.email, circleName: link.circleName };
    const now = this.now();
    const counts = { memberCount: this.memberList.length, liveCount: liveCount(this.memberList, now) };
    if (this.phase === "paused" && this.retryAt) return { state: "paused", email: link.email, circleName: link.circleName, retryAt: this.retryAt.toISOString(), ...counts };
    return {
      state: "linked",
      email: link.email,
      circleName: link.circleName,
      ...counts,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      refreshAvailableAt: this.refreshAvailableAt && this.refreshAvailableAt > now ? this.refreshAvailableAt.toISOString() : null,
    };
  }

  /** Send a login code to the e-mail address (allowed in every state; at most once per minute). */
  async sendCode(email: string): Promise<Life360AdminStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      const now = this.now();
      if (this.nextSendAt && now < this.nextSendAt) throw new ServiceError(429, SEND_WAIT);
      const deviceId = this.link?.deviceId ?? this.processDeviceId;
      let transactionId: string;
      try {
        ({ transactionId } = await this.options.client.sendCode(email, deviceId));
      } catch (error) {
        if (error instanceof Life360NotFoundError) throw new ServiceError(404, "Geen Life360-account met dit adres.");
        if (error instanceof Life360RateLimitedError || error instanceof Life360BlockedError) {
          const wait = Math.max(error instanceof Life360RateLimitedError ? (error.retryAfterMs ?? 0) : 0, SEND_BLOCK_MIN_MS);
          this.nextSendAt = new Date(now.getTime() + wait);
          this.options.logger.warn(`Life360 refused to send a code (${describeError(error)}), next try after ${this.nextSendAt.toISOString()}`);
          throw new ServiceError(429, SEND_WAIT);
        }
        if (error instanceof Life360UpstreamError && error.status === 400) throw new ServiceError(400, "E-mailadres is ongeldig.");
        this.options.logger.warn(`Life360 code not sent: ${describeError(error)}`);
        throw new ServiceError(502, UNREACHABLE);
      }
      this.nextSendAt = new Date(now.getTime() + RESEND_MS);
      this.choosing = null;
      this.pending = { email, transactionId, deviceId, resendAt: this.nextSendAt, expiresAt: new Date(now.getTime() + PENDING_CODE_MS) };
      this.options.logger.info("Life360 login code sent");
      return this.status();
    });
  }

  /** The 6-digit code of the pending login → circle choice, or linked when the account is in one circle. */
  async verifyCode(code: string, linkedBy: string | null): Promise<Life360AdminStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      const pending = this.currentPending();
      if (!pending) throw new ServiceError(409, "Er wacht geen code, vraag eerst een code aan.");
      let token: string;
      try {
        token = await this.options.client.verifyCode(pending.transactionId, code, pending.deviceId);
      } catch (error) {
        if (error instanceof Life360CodeInvalidError) throw new ServiceError(400, "Code klopt niet of is verlopen.");
        throw this.loginFailure(error, "code check");
      }
      // No re-check of this.pending: every step that changes it (send, unlink, …) runs under the same lock
      this.pending = null;
      return this.acceptToken(token, pending.email, pending.deviceId, linkedBy);
    });
  }

  async chooseCircle(circleId: string, linkedBy: string | null): Promise<Life360AdminStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      const choosing = this.choosing;
      if (!choosing) throw new ServiceError(409, "Er hoeft geen kring gekozen te worden.");
      const circle = choosing.circles.find((candidate) => candidate.id === circleId);
      if (!circle) throw new ServiceError(400, "Onbekende kring.");
      await this.saveLink(choosing.token, choosing.email, choosing.deviceId, circle, linkedBy);
      return this.status();
    });
  }

  /** Fallback: a LIFE360_AUTH_TOKEN cookie value pasted by an admin. */
  async pasteToken(token: string, linkedBy: string | null): Promise<Life360AdminStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      const clean = token
        .trim()
        .replace(/^bearer\s+/i, "")
        .trim();
      if (!clean) throw new ServiceError(400, "Token werkt niet.");
      return this.acceptToken(clean, null, this.link?.deviceId ?? this.processDeviceId, linkedBy);
    });
  }

  /** Ask Life360 for a fresh fix of every member (best effort, in the background); at most once per minute. */
  async refresh(): Promise<{ refreshAvailableAt: string }> {
    this.requireConfig();
    const link = this.link;
    if (!link?.token || this.phase !== "linked") throw new ServiceError(409, "Life360 is niet gekoppeld.");
    const now = this.now();
    if (this.refreshAvailableAt && now < this.refreshAvailableAt) throw new ServiceError(429, "Even wachten, verversen kan één keer per minuut.");
    this.refreshAvailableAt = new Date(now.getTime() + REFRESH_COOLDOWN_MS);
    void this.requestLocations(
      link.token,
      link.circleId,
      this.memberList.map((member) => member.id),
      this.generation,
    );
    return { refreshAvailableAt: this.refreshAvailableAt.toISOString() };
  }

  /**
   * Cancel a pending login; without one, delete the link and forget the members. A pending login that has expired still
   * counts as one (the admin clicked cancel on it), so that click never deletes a working link. Runs under the login lock
   * (409 while a login step is running), so a login that saves its link can't race the delete and leave the database and
   * memory apart.
   */
  async unlink(): Promise<Life360AdminStatus> {
    this.requireConfig();
    return this.exclusive(async () => {
      if (this.pending || this.choosing) {
        this.pending = null;
        this.choosing = null;
        this.options.logger.info("Life360 login cancelled");
        return this.status();
      }
      // Delete first: when it throws, the link and its polling stay as they were
      await this.links.deleteOne({ key: LIFE360_LINK_KEY });
      this.generation++;
      this.clearTimer();
      this.link = null;
      this.phase = "linked";
      this.retryAt = null;
      this.backoffMs = 0;
      this.lastPollAt = null;
      this.refreshAvailableAt = null;
      this.clearMembers();
      this.options.logger.info("Life360 unlinked");
      return this.status();
    });
  }

  /** The latest members (memory only). `stale` while logged out or paused: these are the last known positions. */
  members(): Life360Members {
    if (!this.options.config || !this.link) return { linked: false, stale: false, members: [] };
    return { linked: true, stale: this.phase !== "linked", members: this.memberList };
  }

  /**
   * The avatar of a member, fetched from Life360 by the server (cached 1 h) so browsers never contact Life360. While logged
   * out or paused only the cache (whatever its age) is served. A failed fetch is remembered for 5 min, and concurrent
   * requests for one member share one fetch.
   */
  async avatar(memberId: string): Promise<{ contentType: string; body: Buffer }> {
    const source = this.avatarSources.get(memberId);
    if (!source || !this.link) throw new ServiceError(404, NO_AVATAR);
    const now = this.now().getTime();
    const cached = this.avatarCache.get(memberId);
    const usable = cached && cached.source === source ? cached : null;
    const image = (entry: CachedAvatar) => ({ contentType: entry.contentType, body: entry.body });
    if (usable && (this.phase !== "linked" || now - usable.fetchedAt < AVATAR_CACHE_MS)) return image(usable);
    if (this.phase !== "linked") throw new ServiceError(404, NO_AVATAR);
    const failed = this.avatarFailures.get(memberId);
    if (failed && failed.source === source && now < failed.until) {
      if (usable) return image(usable);
      throw new ServiceError(failed.status, failed.status === 404 ? NO_AVATAR : AVATAR_UNAVAILABLE);
    }
    let fetching = this.avatarFetches.get(memberId);
    if (!fetching || fetching.source !== source) {
      // Removed when done, but only if still this fetch: an older one (from before an unlink/relink) must not drop a newer one
      const promise: Promise<CachedAvatar | 404 | 502> = this.fetchAvatar(memberId, source).finally(() => {
        if (this.avatarFetches.get(memberId)?.promise === promise) this.avatarFetches.delete(memberId);
      });
      fetching = { source, promise };
      this.avatarFetches.set(memberId, fetching);
    }
    const fetched = await fetching.promise;
    if (typeof fetched !== "number") return image(fetched);
    if (usable) return image(usable);
    throw new ServiceError(fetched, fetched === 404 ? NO_AVATAR : AVATAR_UNAVAILABLE);
  }

  /** One members call and its consequences; never throws. Called by the timer (and by tests). */
  async pollOnce(): Promise<void> {
    const link = this.link;
    if (this.stopped || !link?.token || this.phase === "loggedOut") return;
    const generation = this.generation;
    const started = this.now();
    const full = !this.lastFullPollAt || started.getTime() - this.lastFullPollAt.getTime() >= FULL_POLL_MS;
    try {
      const result = await this.options.client.members(link.token, link.circleId, full ? undefined : (this.etag ?? undefined));
      if (generation !== this.generation) return;
      if (!result.notModified) {
        const parsed = parseMembers(result.members);
        this.memberList = parsed.map((entry) => entry.member);
        this.avatarSources = new Map(parsed.flatMap((entry) => (entry.avatarSource ? [[entry.member.id, entry.avatarSource] as const] : [])));
        for (const id of [...this.avatarCache.keys()]) if (!this.avatarSources.has(id)) this.avatarCache.delete(id);
        for (const id of [...this.avatarFailures.keys()]) if (!this.avatarSources.has(id)) this.avatarFailures.delete(id);
        this.etag = result.etag;
        if (full) this.lastFullPollAt = started;
      }
      if (this.phase === "paused") this.options.logger.info("Life360 polling resumed");
      this.phase = "linked";
      this.retryAt = null;
      this.backoffMs = 0;
      this.lastPollAt = started;
      this.schedule(this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
    } catch (error) {
      if (generation !== this.generation) return;
      this.handlePollError(error, started);
    }
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The pending login, dropped once expired */
  private currentPending(): PendingCode | null {
    if (this.pending && this.now() >= this.pending.expiresAt) {
      this.pending = null;
      this.options.logger.info("Life360 login code expired");
    }
    return this.pending;
  }

  private requireConfig(): Life360Config {
    if (!this.options.config) throw new ServiceError(503, NOT_CONFIGURED);
    return this.options.config;
  }

  /** One login step at a time (two admins, or a double click) */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ServiceError(409, BUSY);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private loginFailure(error: unknown, step: string): ServiceError {
    if (error instanceof Life360RateLimitedError || error instanceof Life360BlockedError) return new ServiceError(429, LIMITED);
    this.options.logger.warn(`Life360 ${step} failed: ${describeError(error)}`);
    return new ServiceError(502, UNREACHABLE);
  }

  /** A fresh token: check it, list its circles, then link (one circle) or let the admin choose. */
  private async acceptToken(token: string, email: string | null, deviceId: string, linkedBy: string | null): Promise<Life360AdminStatus> {
    let account: { email: string | null };
    try {
      account = await this.options.client.me(token);
    } catch (error) {
      if (error instanceof Life360UnauthorizedError) throw new ServiceError(400, "Token werkt niet.");
      throw this.loginFailure(error, "token check");
    }
    let circles: Life360Circle[];
    try {
      circles = await this.options.client.circles(token);
    } catch (error) {
      if (error instanceof Life360UnauthorizedError) throw new ServiceError(400, "Token werkt niet.");
      throw this.loginFailure(error, "circle list");
    }
    if (circles.length === 0) throw new ServiceError(400, "Dit Life360-account zit in geen enkele kring.");
    const accountEmail = email ?? account.email ?? "onbekend account";
    this.pending = null;
    if (circles.length === 1) {
      this.choosing = null;
      await this.saveLink(token, accountEmail, deviceId, circles[0], linkedBy);
      return this.status();
    }
    this.choosing = { email: accountEmail, token, deviceId, circles };
    return this.status();
  }

  private async saveLink(token: string, email: string, deviceId: string, circle: Life360Circle, linkedBy: string | null) {
    const config = this.requireConfig();
    const sealed = encryptSession(token, config.sessionKey);
    await this.links.updateOne(
      { key: LIFE360_LINK_KEY },
      {
        $set: {
          key: LIFE360_LINK_KEY,
          tokenCiphertext: sealed.ciphertext,
          iv: sealed.iv,
          tag: sealed.tag,
          email,
          deviceId,
          circleId: circle.id,
          circleName: circle.name,
          linkedBy,
          linkedAt: this.now(),
        },
      },
      { upsert: true },
    );
    this.generation++;
    this.clearTimer();
    const sameCircle = this.link?.circleId === circle.id;
    this.link = { token, email, deviceId, circleId: circle.id, circleName: circle.name };
    this.pending = null;
    this.choosing = null;
    this.phase = "linked";
    this.retryAt = null;
    this.backoffMs = 0;
    // Logging in again to the same circle keeps the last members until the first poll
    if (!sameCircle) {
      this.clearMembers();
      this.lastPollAt = null;
    }
    this.etag = null;
    this.lastFullPollAt = null;
    this.options.logger.info(`Life360 linked to circle ${circle.name} (${linkedBy ?? "unknown admin"})`);
    this.schedule(0);
  }

  private clearMembers() {
    this.memberList = [];
    this.avatarSources = new Map();
    this.avatarCache.clear();
    this.avatarFailures.clear();
    this.avatarFetches.clear();
    this.etag = null;
    this.lastFullPollAt = null;
  }

  private handlePollError(error: unknown, started: Date) {
    if (error instanceof Life360UnauthorizedError) {
      this.phase = "loggedOut";
      this.retryAt = null;
      this.clearTimer();
      this.options.logger.warn("Life360 answered 401: the token is no longer valid, an admin has to log in again");
      return;
    }
    if (error instanceof Life360RateLimitedError || error instanceof Life360BlockedError) {
      const wait = error instanceof Life360RateLimitedError ? Math.max(error.retryAfterMs ?? 0, PAUSE_MIN_MS) : BLOCKED_PAUSE_MS;
      this.phase = "paused";
      this.retryAt = new Date(started.getTime() + wait);
      this.backoffMs = 0;
      this.options.logger.warn(`Life360 polling paused until ${this.retryAt.toISOString()}: ${describeError(error)}`);
      this.schedule(wait);
      return;
    }
    // Network or an unexpected answer: keep the state, try again later
    this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : BACKOFF_INITIAL_MS, BACKOFF_MAX_MS);
    this.options.logger.warn(`Life360 poll failed, retrying in ${Math.round(this.backoffMs / 1000)} s: ${describeError(error)}`);
    this.schedule(this.backoffMs);
  }

  private schedule(delayMs: number) {
    this.clearTimer();
    if (this.stopped || !this.link?.token) return;
    this.scheduledAt = new Date(this.now().getTime() + delayMs);
    if (this.options.autoPoll === false) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce().catch((error) => this.options.logger.error("Life360 poll crashed", error));
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = null;
  }

  /** One Life360 fetch of an avatar; caches the image or remembers the failure (5 min) and answers its status. Never throws. */
  private async fetchAvatar(memberId: string, source: string): Promise<CachedAvatar | 404 | 502> {
    const generation = this.generation;
    try {
      const fetched = await this.options.client.avatar(source);
      const entry = { source, contentType: fetched.contentType, body: fetched.body, fetchedAt: this.now().getTime() };
      if (generation === this.generation) {
        this.avatarCache.set(memberId, entry);
        this.avatarFailures.delete(memberId);
      }
      return entry;
    } catch (error) {
      const status: 404 | 502 = error instanceof Life360NotFoundError ? 404 : 502;
      if (status === 502) this.options.logger.warn(`Life360 avatar not fetched: ${describeError(error)}`);
      if (generation === this.generation) this.avatarFailures.set(memberId, { source, status, until: this.now().getTime() + AVATAR_FAILURE_MS });
      return status;
    }
  }

  private async requestLocations(token: string, circleId: string, memberIds: string[], generation: number) {
    for (const memberId of memberIds) {
      if (generation !== this.generation) return;
      try {
        await this.options.client.requestLocation(token, circleId, memberId);
      } catch (error) {
        // Some members can't be asked (ha-life360 #98): skip them
        if (error instanceof Life360NotFoundError) continue;
        this.options.logger.warn(`Life360 refresh stopped: ${describeError(error)}`);
        return;
      }
    }
  }
}

// --- Process instance -----------------------------------------------------------------------------------------------

let instance: Life360Service | null = null;

/** The service of this process; null before startup wiring (index.ts) and in tests that don't set one. */
export function getLife360Service(): Life360Service | null {
  return instance;
}

export function setLife360Service(service: Life360Service | null) {
  instance = service;
}
