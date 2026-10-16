import type { Connection, Model } from "mongoose";
import { ServiceError } from "../http/service-error";
import { AppNotification } from "../models/notification.model";
import { TELEGRAM_LINK_KEY, telegramLinkModel, type TelegramLinkDoc } from "../models/telegram-link.model";
import { telegramMessageModel, type TelegramMessageDoc } from "../models/telegram-message.model";
import { runTracked, runTrackedRetrying } from "../demo/demo-mode";
import { sendToAll } from "./push.service";
import {
  buildTelegramCounterHuntNotification,
  classifyBotMessage,
  COUNTER_HUNT_WINDOW_MS,
  isBotMessage,
  maskPhone,
  parseCounterHuntDirection,
  type BotMessageKind,
} from "./telegram.helpers";
import { decryptSession, encryptSession, isValidSessionKey } from "./session-crypto";
import { plain, secret } from "../settings/app-config";
import { errorText } from "../utils/error-text";
import type { ServiceLogger } from "../utils/service-logger";
import { serviceSlot } from "../utils/service-slot";

// --- Gateway (the Telegram client, mtcute in telegram.gateway.ts; faked in tests) --------------------------------

export interface TelegramAccount {
  id: number;
  name: string;
  username?: string;
  phone?: string;
}

export interface TelegramIncomingMessage {
  id: number;
  senderUsername?: string;
  /** The sender is a bot account */
  senderIsBot?: boolean;
  /** Sent in the private chat with the sender (not a group or channel) */
  privateChat?: boolean;
  text: string;
  date: Date;
}

/** One Telegram client: a QR login, or a connection with a stored session. Not reused after `cancel()`. */
export interface TelegramGateway {
  /**
   * Start a QR login. `onUrl` is called with every (rotating) tg://login URL. Resolves 'linked' once logged in, or
   * 'password' when the account has a 2FA password: then `submitPassword` finishes the login.
   */
  startQr(handlers: { onUrl(url: string, expires: Date): void; onScanned(): void }): Promise<"linked" | "password">;
  /** The 2FA password hint, if the account set one. */
  passwordHint(): Promise<string | null>;
  /** Resolves once logged in; throws WrongPasswordError (the login keeps waiting for another try). */
  submitPassword(password: string): Promise<void>;
  me(): Promise<TelegramAccount>;
  /** The session string of a logged-in client (secret). */
  exportSession(): Promise<string>;
  /** Connect with a stored session and start receiving messages; throws SessionRevokedError when it is no longer valid. */
  connect(session: string): Promise<void>;
  onMessage(callback: (message: TelegramIncomingMessage) => void): void;
  /** The latest messages of the chat with the bot (catch-up after a restart; may include other senders). */
  recentBotMessages(limit: number): Promise<TelegramIncomingMessage[]>;
  /** Called when a running session is revoked (logged out from another device). */
  onRevoked(callback: () => void): void;
  /** Log the session out at Telegram. */
  logout(): Promise<void>;
  /** Abort a pending login and close the client. */
  cancel(): Promise<void>;
}

export type TelegramGatewayFactory = (config: TelegramConfig) => TelegramGateway;

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong Telegram password");
    this.name = "WrongPasswordError";
  }
}

export class SessionRevokedError extends Error {
  constructor() {
    super("The Telegram session is no longer valid");
    this.name = "SessionRevokedError";
  }
}

// --- Config -------------------------------------------------------------------------------------------------------

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  /** TELEGRAM_SESSION_KEY, base64 of 32 bytes */
  sessionKey: string;
  botUsername: string;
}

export const DEFAULT_BOT_USERNAME = "Jotihunt_bot";

/**
 * Config from Beheer (else TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_USERNAME), or null (feature off) without
 * an API ID and hash. A missing or invalid TELEGRAM_SESSION_KEY also turns the feature off, with a warning.
 */
export function telegramConfigFromSettings(env: Record<string, string | undefined>, warn: (message: string) => void): TelegramConfig | null {
  const rawId = plain("telegramApiId");
  const apiHash = secret("telegramApiHash");
  if (!rawId || !apiHash) return null;
  const apiId = Number(rawId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    warn("Telegram API ID is not a number, Telegram is off");
    return null;
  }
  const sessionKey = env.TELEGRAM_SESSION_KEY?.trim() ?? "";
  if (!isValidSessionKey(sessionKey)) {
    warn("TELEGRAM_SESSION_KEY is missing or not 32 bytes (base64), Telegram is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { apiId, apiHash, sessionKey, botUsername: plain("telegramBotUsername") || DEFAULT_BOT_USERNAME };
}

// --- API shapes ---------------------------------------------------------------------------------------------------

export type TelegramState = "unavailable" | "unlinked" | "qr" | "password" | "linked";

export interface TelegramAdminStatus {
  state: TelegramState;
  url?: string;
  expiresAt?: string;
  hint?: string;
  account?: { name: string; username?: string; phoneMasked?: string };
  linkedAt?: string;
  lastMessageAt?: string;
  /** The listener is running (linked and connected) */
  connected: boolean;
  /** Short Dutch description of the last problem (no secrets) */
  lastError?: string;
  /** Unavailable only because the API ID/hash are missing (set them in Beheer) */
  needsAppCredentials?: boolean;
}

export interface TelegramMessages {
  linked: boolean;
  /** Messages are coming in right now; false while linked means the connection is lost */
  connected: boolean;
  messages: { id: string; text: string; kind: BotMessageKind; receivedAt: string }[];
}

// --- Service ------------------------------------------------------------------------------------------------------

interface PendingLogin {
  gateway: TelegramGateway;
  state: "qr" | "password";
  url?: string;
  expiresAt?: Date;
  hint?: string;
  linkedBy: string | null;
  failed?: boolean;
  submitting?: boolean;
  /** Telegram accepted the login (the gateway holds a live session that must be logged out when cancelled) */
  loggedIn?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TelegramServiceOptions {
  /** null: feature off (no API id/hash), the routes still answer. Replaced by `reconfigure()` */
  config: TelegramConfig | null;
  /** TELEGRAM_SESSION_KEY is valid: without app credentials the status asks for them */
  sessionKeyOk?: boolean;
  /** Connection to the REAL database (the demo state store's), so the link survives demo mode */
  connection: Connection;
  gateway: TelegramGatewayFactory;
  logger: ServiceLogger;
  /** Reconnect backoff with a stored session */
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** How long POST /admin/telegram/link waits for the first QR URL */
  firstUrlTimeoutMs?: number;
  /** A login nobody finishes is cancelled after this */
  pendingTimeoutMs?: number;
  /** Wait between tries when a tegenhunt alert is skipped by a running demo switch, and how often to try */
  alertRetryMs?: number;
  alertAttempts?: number;
  /** Receives the happy-hour messages (happy-hour.service.ts); throws when a message could not be handled */
  happyHour?: { handleMessage(message: { telegramId: number; text: string; date: Date }): Promise<void> };
  /** Tests only */
  now?: () => Date;
}

const MESSAGES_LIMIT = 50;
const MESSAGES_MAX = 200;
/** Messages read from the bot chat after every connect, to catch up on what came in while the server was down */
const CATCH_UP_LIMIT = 30;
const LINK_FAILED = "Koppelen met Telegram is mislukt.";
const NOT_CONNECTED = "Geen verbinding met Telegram, wordt opnieuw geprobeerd.";
const CANNOT_DECRYPT = "Sessie kan niet worden ontsleuteld (TELEGRAM_SESSION_KEY gewijzigd?)";
const REVOKED = "De sessie is ingetrokken in Telegram; koppel opnieuw.";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * The group's Telegram account: linking by QR (admins), listening to @Jotihunt_bot and alerting everyone on a
 * tegenhunt. One listener per server process (the server runs as a single replica). At most one pending login.
 *
 * Demo mode: the link and the bot messages live in the real database, but alerts (notifications, happy hours) are
 * written to the current database like every other alert. A real tegenhunt during demo mode therefore lands in the
 * demo database and is gone when demo mode is switched off (accepted: demo mode is not used during the event).
 */
export class TelegramService {
  private readonly links: Model<TelegramLinkDoc>;
  private readonly messages: Model<TelegramMessageDoc>;
  private pending: PendingLogin | null = null;
  private active: TelegramGateway | null = null;
  /** Ciphertext of the active session, so a revoked session only deletes its own link */
  private activeCiphertext: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  /** Bumped on every link/unlink, so a slow reconnect or link of an old state never becomes active */
  private linkGeneration = 0;
  private stopped = false;
  private lastError: string | null = null;
  /** Telegram ids being handled right now (live and catch-up can deliver the same message at once) */
  private readonly handling = new Set<number>();

  constructor(private readonly options: TelegramServiceOptions) {
    this.links = telegramLinkModel(options.connection);
    this.messages = telegramMessageModel(options.connection);
    this.retryDelay = options.retryInitialMs ?? 5_000;
  }

  get available(): boolean {
    return this.options.config !== null;
  }

  /** Build the indexes and, when a link is stored, connect and start listening (retried in the background). */
  async start(): Promise<void> {
    await Promise.all([this.links.createIndexes(), this.messages.createIndexes()]);
    if (!this.options.config) return;
    await this.connectStored();
  }

  /** Cancel everything (shutdown, tests). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    await this.cancelPending();
    const active = this.active;
    this.active = null;
    await active?.cancel().catch(() => undefined);
  }

  /** New app credentials from Beheer: drop the current connection and connect again with the stored link (if any). */
  async reconfigure(config: TelegramConfig | null): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.linkGeneration++;
    this.lastError = null;
    this.retryDelay = this.options.retryInitialMs ?? 5_000;
    this.options.config = config;
    if (config) await this.connectStored();
  }

  async status(): Promise<TelegramAdminStatus> {
    if (!this.options.config) return { state: "unavailable", connected: false, ...(this.options.sessionKeyOk && { needsAppCredentials: true }) };
    const pending = this.pending;
    if (pending) {
      const status: TelegramAdminStatus = { state: pending.state, connected: false };
      if (pending.state === "qr" && pending.url) status.url = pending.url;
      if (pending.state === "qr" && pending.expiresAt) status.expiresAt = pending.expiresAt.toISOString();
      if (pending.state === "password" && pending.hint) status.hint = pending.hint;
      return status;
    }
    const link = await this.readLink();
    if (!link) return this.withError({ state: "unlinked", connected: false });
    const account: NonNullable<TelegramAdminStatus["account"]> = { name: link.account.name };
    if (link.account.username) account.username = link.account.username;
    if (link.account.phoneMasked) account.phoneMasked = link.account.phoneMasked;
    const status: TelegramAdminStatus = { state: "linked", account, linkedAt: link.linkedAt.toISOString(), connected: this.active !== null };
    const last = await this.messages.findOne({}, { receivedAt: 1 }).sort({ receivedAt: -1 }).lean();
    if (last) status.lastMessageAt = last.receivedAt.toISOString();
    return status.connected ? status : this.withError(status);
  }

  /** Start a QR login (or return the running one); answers once the first QR URL is known. */
  async startLink(linkedBy: string | null): Promise<TelegramAdminStatus> {
    const config = this.requireConfig();
    if (this.pending) return this.status();
    if (await this.readLink()) throw new ServiceError(409, "Telegram is al gekoppeld.");
    if (this.pending) return this.status();

    this.lastError = null;
    const gateway = this.options.gateway(config);
    const pending: PendingLogin = { gateway, state: "qr", linkedBy };
    this.pending = pending;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.options.logger.warn("Telegram login not finished in time, cancelled");
      void this.cancelPending();
    }, this.options.pendingTimeoutMs ?? 5 * 60_000);
    pending.timer.unref?.();

    let firstUpdate!: () => void;
    const updated = new Promise<void>((resolve) => (firstUpdate = resolve));
    gateway
      .startQr({
        onUrl: (url, expires) => {
          if (this.pending !== pending) return;
          pending.url = url;
          pending.expiresAt = expires;
          firstUpdate();
        },
        onScanned: () => this.options.logger.info("Telegram login QR code scanned"),
      })
      .then(async (result) => {
        if (this.pending !== pending) return;
        if (result === "password") {
          pending.hint = (await gateway.passwordHint().catch(() => null)) ?? undefined;
          pending.state = "password";
          pending.url = undefined;
          pending.expiresAt = undefined;
          return;
        }
        pending.loggedIn = true;
        await this.completeLink(pending).catch(() => undefined);
      })
      .catch(async (error) => {
        // Also after the password state: the login gave up (cancelled, timed out at Telegram, network)
        if (this.pending !== pending) return;
        await this.failPending(pending, error);
      })
      .finally(() => firstUpdate());

    await Promise.race([updated, delay(this.options.firstUrlTimeoutMs ?? 20_000)]);
    if (pending.failed) throw new ServiceError(502, LINK_FAILED);
    return this.status();
  }

  /** The 2FA cloud password of a pending login. A wrong password: 400 and the login keeps waiting. */
  async submitPassword(password: string): Promise<TelegramAdminStatus> {
    this.requireConfig();
    const pending = this.pending;
    if (!pending || pending.state !== "password" || pending.submitting) throw new ServiceError(409, "Er wordt geen wachtwoord gevraagd.");
    pending.submitting = true;
    try {
      await pending.gateway.submitPassword(password);
    } catch (error) {
      if (error instanceof WrongPasswordError) throw new ServiceError(400, "Wachtwoord klopt niet.");
      if (this.pending === pending) await this.failPending(pending, error);
      throw new ServiceError(502, LINK_FAILED);
    } finally {
      pending.submitting = false;
    }
    pending.loggedIn = true;
    if (this.pending !== pending) throw new ServiceError(409, "Het koppelen is afgebroken.");
    await this.completeLink(pending);
    return this.status();
  }

  /** Cancel a pending login, or log the linked session out and delete the link and its bot messages. */
  async unlink(): Promise<void> {
    this.requireConfig();
    this.linkGeneration++;
    this.lastError = null;
    await this.cancelPending();
    this.clearRetry();
    const active = this.active;
    this.active = null;
    this.activeCiphertext = null;
    if (active) {
      await active.logout().catch((error) => this.options.logger.warn(`Could not log the Telegram session out: ${errorText(error)}`));
      await active.cancel().catch(() => undefined);
    } else if (await this.readLink()) {
      this.options.logger.warn("Telegram unlinked while not connected; the session may still be listed in Telegram (Settings > Devices)");
    }
    await this.links.deleteOne({ key: TELEGRAM_LINK_KEY });
    // The messages belong to the unlinked account: the card starts empty, also for a new link
    await this.messages.deleteMany({});
    this.options.logger.info("Telegram unlinked");
  }

  /** Newest first. `linked`/`connected` tell the card which empty or warning state to show. */
  async listMessages(limit = MESSAGES_LIMIT): Promise<TelegramMessages> {
    const count = Math.min(Math.max(Math.trunc(limit) || MESSAGES_LIMIT, 1), MESSAGES_MAX);
    const [link, messages] = await Promise.all([
      this.options.config ? this.readLink() : null,
      this.messages.find().sort({ receivedAt: -1, telegramId: -1 }).limit(count).lean(),
    ]);
    return {
      linked: link !== null,
      connected: link !== null && this.active !== null,
      messages: messages.map((message) => ({ id: String(message.telegramId), text: message.text ?? "", kind: message.kind, receivedAt: message.receivedAt.toISOString() })),
    };
  }

  /**
   * Store a bot message once (by Telegram id) and handle it: alert everyone on a tegenhunt, pass a happy hour on.
   * Messages of anyone else are ignored. `handledAt` is set only once handling succeeded, so a failure is retried on
   * the next delivery or catch-up; the alerts themselves are deduplicated per Telegram id.
   */
  async handleMessage(message: TelegramIncomingMessage): Promise<void> {
    const config = this.options.config;
    if (!config || !isBotMessage(message, config.botUsername)) return;
    if (this.handling.has(message.id)) return;
    this.handling.add(message.id);
    try {
      const kind = classifyBotMessage(message.text);
      const data = kind === "tegenhunt" ? { direction: parseCounterHuntDirection(message.text) } : {};
      let stored = await this.messages.findOne({ telegramId: message.id }, { handledAt: 1 }).lean();
      if (!stored) {
        try {
          await this.messages.create({ telegramId: message.id, text: message.text, kind, receivedAt: message.date, data, handledAt: null });
          this.options.logger.info(`Message from @${config.botUsername} (${kind})`);
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          stored = await this.messages.findOne({ telegramId: message.id }, { handledAt: 1 }).lean();
        }
      }
      if (stored?.handledAt) return;
      await this.process({ id: message.id, text: message.text, date: message.date }, kind);
      await this.messages.updateOne({ telegramId: message.id }, { $set: { handledAt: new Date() } });
    } finally {
      this.handling.delete(message.id);
    }
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  /** What a bot message triggers. Throws when it could not be done (the message stays unhandled). */
  private async process(message: { id: number; text: string; date: Date }, kind: BotMessageKind) {
    // Read late (catch-up after a restart): a tegenhunt older than its 30 minutes is only stored
    const age = (this.options.now?.() ?? new Date()).getTime() - message.date.getTime();
    if (kind === "tegenhunt" && age < COUNTER_HUNT_WINDOW_MS) await this.alertCounterHunt(message);
    if (kind === "happy-hour") await this.options.happyHour?.handleMessage({ telegramId: message.id, text: message.text, date: message.date });
  }

  private withError(status: TelegramAdminStatus): TelegramAdminStatus {
    return this.lastError ? { ...status, lastError: this.lastError } : status;
  }

  private requireConfig(): TelegramConfig {
    if (!this.options.config) throw new ServiceError(503, "Telegram is niet ingesteld op de server.");
    return this.options.config;
  }

  private readLink() {
    return this.links.findOne({ key: TELEGRAM_LINK_KEY }).lean<TelegramLinkDoc>();
  }

  /** Delete the link, but only the one with this session (a newer link stays). */
  private deleteLink(ciphertext: string | null) {
    return this.links.deleteOne(ciphertext ? { key: TELEGRAM_LINK_KEY, sessionCiphertext: ciphertext } : { key: TELEGRAM_LINK_KEY });
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async cancelPending() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    // A login that Telegram already accepted leaves an active session behind unless it is logged out
    if (pending.loggedIn) await pending.gateway.logout().catch(() => undefined);
    await pending.gateway.cancel().catch(() => undefined);
  }

  private async failPending(pending: PendingLogin, error: unknown) {
    this.options.logger.warn(`Telegram login failed: ${errorText(error)}`);
    pending.failed = true;
    this.lastError = LINK_FAILED;
    await this.cancelPending();
  }

  /**
   * Store the session of a finished login and keep its client as the listener. The pending login is claimed before
   * the write; when an unlink or another link happened meanwhile, the write is rolled back and the session logged out.
   */
  private async completeLink(pending: PendingLogin) {
    const config = this.requireConfig();
    const { gateway } = pending;
    let account: TelegramAccount;
    let ciphertext: { ciphertext: string; iv: string; tag: string };
    try {
      account = await gateway.me();
      ciphertext = encryptSession(await gateway.exportSession(), config.sessionKey);
    } catch (error) {
      if (this.pending === pending) await this.failPending(pending, error);
      throw new ServiceError(502, LINK_FAILED);
    }
    if (this.pending !== pending) {
      // Cancelled while finishing (cancelPending logged it out)
      throw new ServiceError(409, "Het koppelen is afgebroken.");
    }
    // Claim: from here on a cancel or unlink can't reach this login anymore, the generation check below catches it
    clearTimeout(pending.timer);
    this.pending = null;
    const generation = ++this.linkGeneration;
    const rollBack = async () => {
      await this.deleteLink(ciphertext.ciphertext).catch(() => undefined);
      await gateway.logout().catch(() => undefined);
      await gateway.cancel().catch(() => undefined);
    };
    try {
      await this.links.updateOne(
        { key: TELEGRAM_LINK_KEY },
        {
          $set: {
            key: TELEGRAM_LINK_KEY,
            sessionCiphertext: ciphertext.ciphertext,
            iv: ciphertext.iv,
            tag: ciphertext.tag,
            account: { id: account.id, name: account.name, username: account.username ?? null, phoneMasked: account.phone ? maskPhone(account.phone) : null },
            linkedAt: new Date(),
            linkedBy: pending.linkedBy,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      this.options.logger.error("Could not store the Telegram link", error);
      this.lastError = LINK_FAILED;
      await rollBack();
      throw new ServiceError(502, LINK_FAILED);
    }
    if (generation !== this.linkGeneration || this.stopped) {
      await rollBack();
      throw new ServiceError(409, "Het koppelen is afgebroken.");
    }
    this.clearRetry();
    this.lastError = null;
    const previous = this.active;
    this.activate(gateway, ciphertext.ciphertext);
    await previous?.cancel().catch(() => undefined);
    this.options.logger.info(`Telegram linked (${pending.linkedBy ?? "unknown admin"}), listening to @${config.botUsername}`);
  }

  private activate(gateway: TelegramGateway, ciphertext: string) {
    this.active = gateway;
    this.activeCiphertext = ciphertext;
    gateway.onMessage((message) => {
      if (this.active !== gateway) return;
      this.handleMessage(message).catch((error) => this.options.logger.error("Could not handle a Telegram message (retried at the next catch-up)", error));
    });
    gateway.onRevoked(() => {
      if (this.active !== gateway) return;
      void this.dropRevoked(gateway);
    });
    void this.catchUp(gateway);
  }

  /**
   * Handle the latest messages of the bot chat (oldest first; known ones are skipped by their Telegram id), then the
   * stored messages whose handling failed before.
   */
  private async catchUp(gateway: TelegramGateway) {
    try {
      // Only what came in since the link: the bot chat's older history stays out of the card
      const linkedAt = (await this.readLink())?.linkedAt.getTime() ?? 0;
      const messages = (await gateway.recentBotMessages(CATCH_UP_LIMIT)).filter((message) => message.date.getTime() >= linkedAt);
      for (const message of [...messages].sort((a, b) => a.id - b.id)) {
        if (this.active !== gateway) return;
        await this.handleMessage(message).catch((error) => this.options.logger.error("Could not handle a Telegram message", error));
      }
    } catch (error) {
      this.options.logger.warn(`Could not read the latest Telegram messages: ${errorText(error)}`);
    }
    await this.retryUnhandled().catch((error) => this.options.logger.error("Could not retry unhandled Telegram messages", error));
  }

  private async retryUnhandled() {
    const unhandled = await this.messages.find({ handledAt: null }).sort({ telegramId: 1 }).lean();
    for (const message of unhandled) {
      if (this.handling.has(message.telegramId)) continue;
      this.handling.add(message.telegramId);
      try {
        await this.process({ id: message.telegramId, text: message.text ?? "", date: message.receivedAt }, message.kind);
        await this.messages.updateOne({ telegramId: message.telegramId }, { $set: { handledAt: new Date() } });
      } catch (error) {
        this.options.logger.error(`Could not handle Telegram message ${message.telegramId}`, error);
      } finally {
        this.handling.delete(message.telegramId);
      }
    }
  }

  private async dropRevoked(gateway: TelegramGateway) {
    const ciphertext = this.activeCiphertext;
    this.active = null;
    this.activeCiphertext = null;
    this.linkGeneration++;
    this.lastError = REVOKED;
    await gateway.cancel().catch(() => undefined);
    await this.deleteLink(ciphertext).catch((error) => this.options.logger.error("Could not delete the Telegram link", error));
    this.options.logger.warn("The Telegram session was revoked, link removed; an admin has to link Telegram again");
  }

  private scheduleRetry(error: unknown) {
    if (this.stopped) return;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(wait * 2, this.options.retryMaxMs ?? 5 * 60_000);
    this.lastError = NOT_CONNECTED;
    this.options.logger.warn(`Could not connect to Telegram, retrying in ${Math.round(wait / 1000)} s: ${errorText(error)}`);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectStored();
    }, wait);
    this.retryTimer.unref?.();
  }

  /**
   * Connect with the stored session. A revoked session removes the link; a session that can't be decrypted (the key
   * changed) keeps it and reports the problem; any other failure (network, database) retries with backoff.
   */
  private async connectStored(): Promise<void> {
    const config = this.options.config;
    if (!config || this.stopped) return;
    const generation = this.linkGeneration;
    let gateway: TelegramGateway | null = null;
    try {
      const link = await this.readLink();
      if (!link) return;
      let session: string;
      try {
        session = decryptSession({ ciphertext: link.sessionCiphertext, iv: link.iv, tag: link.tag }, config.sessionKey);
      } catch {
        // Kept: with the old key back in place it works again
        this.lastError = CANNOT_DECRYPT;
        this.options.logger.error("Could not decrypt the stored Telegram session (TELEGRAM_SESSION_KEY changed?); restore the key or link Telegram again");
        return;
      }
      gateway = this.options.gateway(config);
      await gateway.connect(session);
      if (generation !== this.linkGeneration || this.stopped) {
        await gateway.cancel().catch(() => undefined);
        return;
      }
      this.retryDelay = this.options.retryInitialMs ?? 5_000;
      this.lastError = null;
      this.activate(gateway, link.sessionCiphertext);
      this.options.logger.info(`Telegram connected as ${link.account.name}, listening to @${config.botUsername}`);
    } catch (error) {
      await gateway?.cancel().catch(() => undefined);
      if (generation !== this.linkGeneration || this.stopped) return;
      if (error instanceof SessionRevokedError) {
        const link = await this.readLink().catch(() => null);
        await this.deleteLink(link?.sessionCiphertext ?? null).catch(() => undefined);
        this.lastError = REVOKED;
        this.options.logger.warn("The stored Telegram session is no longer valid, link removed; an admin has to link Telegram again");
        return;
      }
      this.scheduleRetry(error);
    }
  }

  /**
   * The counter-hunt notification for a tegenhunt message, like the former admin button: stored in the current
   * database, then pushed. Once per Telegram message; retried while a demo switch is running, then throws.
   */
  private async alertCounterHunt(message: { id: number; text: string; date: Date }) {
    const input = buildTelegramCounterHuntNotification({ telegramId: message.id, text: message.text, date: message.date });
    const result = await runTrackedRetrying(
      async () => {
        if (await AppNotification.exists({ type: "counter-hunt", "data.telegramId": message.id })) return null;
        return AppNotification.create(input);
      },
      { waitMs: this.options.alertRetryMs, attempts: this.options.alertAttempts },
    );
    if (!result) throw new Error(`Tegenhunt alert for Telegram message ${message.id} not sent: a demo switch kept running`);
    const notification = result.value;
    if (!notification) return;
    this.options.logger.info(`Tegenhunt alert sent: ${input.title}`);
    void runTracked(() => sendToAll(notification), { generation: result.generation });
  }
}

// --- Process instance ---------------------------------------------------------------------------------------------

const slot = serviceSlot<TelegramService>("Telegram is niet ingesteld op de server.");

/** The service of this process; null before startup wiring (index.ts) and in tests that don't set one. */
export const getTelegramService = slot.get;
export const setTelegramService = slot.set;
/** The service, or a 503 when none is wired up */
export const requireTelegramService = slot.require;
