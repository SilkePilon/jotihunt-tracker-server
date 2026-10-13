import type { Connection, Model } from "mongoose";
import { ServiceError } from "../http/service-error";
import { AppNotification } from "../models/notification.model";
import { TELEGRAM_LINK_KEY, telegramLinkModel, type TelegramLinkDoc } from "../models/telegram-link.model";
import { telegramMessageModel, type TelegramMessageDoc } from "../models/telegram-message.model";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { sendToAll } from "./push.service";
import {
  buildTelegramCounterHuntNotification,
  classifyBotMessage,
  decodeSessionKey,
  decryptSession,
  encryptSession,
  isBotSender,
  maskPhone,
  parseCounterHuntDirection,
  type BotMessageKind,
} from "./telegram.helpers";

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
 * Config from the environment, or null (feature off) without TELEGRAM_API_ID/TELEGRAM_API_HASH. A missing or invalid
 * TELEGRAM_SESSION_KEY also turns the feature off, with a warning.
 */
export function telegramConfigFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): TelegramConfig | null {
  const apiId = Number(env.TELEGRAM_API_ID?.trim());
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  if (!env.TELEGRAM_API_ID?.trim() || !apiHash) return null;
  if (!Number.isInteger(apiId) || apiId <= 0) {
    warn("TELEGRAM_API_ID is not a number, Telegram is off");
    return null;
  }
  const sessionKey = env.TELEGRAM_SESSION_KEY?.trim() ?? "";
  try {
    decodeSessionKey(sessionKey);
  } catch {
    warn("TELEGRAM_SESSION_KEY is missing or not 32 bytes (base64), Telegram is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { apiId, apiHash, sessionKey, botUsername: env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || DEFAULT_BOT_USERNAME };
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
}

export interface TelegramMessages {
  linked: boolean;
  messages: { id: string; text: string; kind: BotMessageKind; receivedAt: string }[];
}

export interface TelegramLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
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
  timer?: ReturnType<typeof setTimeout>;
}

export interface TelegramServiceOptions {
  /** null: feature off (no API id/hash), the routes still answer */
  config: TelegramConfig | null;
  /** Connection to the REAL database (the demo state store's), so the link survives demo mode */
  connection: Connection;
  gateway: TelegramGatewayFactory;
  logger: TelegramLogger;
  /** Reconnect backoff with a stored session */
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** How long POST /admin/telegram/link waits for the first QR URL */
  firstUrlTimeoutMs?: number;
  /** A login nobody finishes is cancelled after this */
  pendingTimeoutMs?: number;
  /** Wait between tries when a tegenhunt alert is skipped by a running demo switch */
  alertRetryMs?: number;
}

const MESSAGES_LIMIT = 50;
const MESSAGES_MAX = 200;
const ALERT_ATTEMPTS = 30;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * The group's Telegram account: linking by QR (admins), listening to @Jotihunt_bot and alerting everyone on a
 * tegenhunt. One listener per server process (the server runs as a single replica). At most one pending login.
 */
export class TelegramService {
  private readonly links: Model<TelegramLinkDoc>;
  private readonly messages: Model<TelegramMessageDoc>;
  private pending: PendingLogin | null = null;
  private active: TelegramGateway | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  /** Bumped on every link/unlink, so a slow reconnect of an old link never becomes active */
  private linkGeneration = 0;
  private stopped = false;

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

  async status(): Promise<TelegramAdminStatus> {
    if (!this.options.config) return { state: "unavailable" };
    const pending = this.pending;
    if (pending) {
      const status: TelegramAdminStatus = { state: pending.state };
      if (pending.state === "qr" && pending.url) status.url = pending.url;
      if (pending.state === "qr" && pending.expiresAt) status.expiresAt = pending.expiresAt.toISOString();
      if (pending.state === "password" && pending.hint) status.hint = pending.hint;
      return status;
    }
    const link = await this.readLink();
    if (!link) return { state: "unlinked" };
    const account: NonNullable<TelegramAdminStatus["account"]> = { name: link.account.name };
    if (link.account.username) account.username = link.account.username;
    if (link.account.phoneMasked) account.phoneMasked = link.account.phoneMasked;
    const status: TelegramAdminStatus = { state: "linked", account, linkedAt: link.linkedAt.toISOString() };
    const last = await this.messages.findOne({}, { receivedAt: 1 }).sort({ receivedAt: -1 }).lean();
    if (last) status.lastMessageAt = last.receivedAt.toISOString();
    return status;
  }

  /** Start a QR login (or return the running one); answers once the first QR URL is known. */
  async startLink(linkedBy: string | null): Promise<TelegramAdminStatus> {
    const config = this.requireConfig();
    if (this.pending) return this.status();
    if (await this.readLink()) throw new ServiceError(409, "Telegram is al gekoppeld.");
    if (this.pending) return this.status();

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
        await this.completeLink(pending);
      })
      .catch(async (error) => {
        if (this.pending !== pending) return;
        this.options.logger.warn(`Telegram login failed: ${describe(error)}`);
        pending.failed = true;
        await this.cancelPending();
      })
      .finally(() => firstUpdate());

    await Promise.race([updated, delay(this.options.firstUrlTimeoutMs ?? 20_000)]);
    if (pending.failed) throw new ServiceError(502, "Koppelen met Telegram is mislukt.");
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
      if (this.pending === pending) {
        this.options.logger.warn(`Telegram login failed: ${describe(error)}`);
        await this.cancelPending();
      }
      throw new ServiceError(502, "Koppelen met Telegram is mislukt.");
    } finally {
      pending.submitting = false;
    }
    if (this.pending !== pending) throw new ServiceError(409, "Het koppelen is afgebroken.");
    await this.completeLink(pending);
    return this.status();
  }

  /** Cancel a pending login, or log the linked session out and delete the link. Stored messages stay. */
  async unlink(): Promise<void> {
    this.requireConfig();
    this.linkGeneration++;
    await this.cancelPending();
    this.clearRetry();
    const active = this.active;
    this.active = null;
    if (active) {
      await active.logout().catch((error) => this.options.logger.warn(`Could not log the Telegram session out: ${describe(error)}`));
      await active.cancel().catch(() => undefined);
    } else if (await this.readLink()) {
      this.options.logger.warn("Telegram unlinked while not connected; the session may still be listed in Telegram (Settings > Devices)");
    }
    await this.links.deleteOne({ key: TELEGRAM_LINK_KEY });
    this.options.logger.info("Telegram unlinked");
  }

  /** Newest first. `linked` tells the card which empty state to show. */
  async listMessages(limit = MESSAGES_LIMIT): Promise<TelegramMessages> {
    const count = Math.min(Math.max(Math.trunc(limit) || MESSAGES_LIMIT, 1), MESSAGES_MAX);
    const [link, messages] = await Promise.all([
      this.options.config ? this.readLink() : null,
      this.messages.find().sort({ receivedAt: -1, telegramId: -1 }).limit(count).lean(),
    ]);
    return {
      linked: link !== null,
      messages: messages.map((message) => ({ id: String(message.telegramId), text: message.text ?? "", kind: message.kind, receivedAt: message.receivedAt.toISOString() })),
    };
  }

  /** Store a bot message once (by Telegram id) and alert everyone when it announces a tegenhunt. Others are ignored. */
  async handleMessage(message: TelegramIncomingMessage): Promise<void> {
    const config = this.options.config;
    if (!config || !isBotSender(message.senderUsername, config.botUsername)) return;
    const kind = classifyBotMessage(message.text);
    const data = kind === "tegenhunt" ? { direction: parseCounterHuntDirection(message.text) } : {};
    try {
      await this.messages.create({ telegramId: message.id, text: message.text, kind, receivedAt: message.date, data });
    } catch (error) {
      if (isDuplicateKey(error)) return;
      throw error;
    }
    this.options.logger.info(`Message from @${config.botUsername} (${kind})`);
    if (kind === "tegenhunt") await this.alertCounterHunt(message);
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  private requireConfig(): TelegramConfig {
    if (!this.options.config) throw new ServiceError(503, "Telegram is niet ingesteld op de server.");
    return this.options.config;
  }

  private readLink() {
    return this.links.findOne({ key: TELEGRAM_LINK_KEY }).lean<TelegramLinkDoc>();
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
    await pending.gateway.cancel().catch(() => undefined);
  }

  /** Store the session of a finished login and keep its client as the listener. */
  private async completeLink(pending: PendingLogin) {
    const config = this.requireConfig();
    const { gateway } = pending;
    try {
      const account = await gateway.me();
      const encrypted = encryptSession(await gateway.exportSession(), config.sessionKey);
      if (this.pending !== pending) {
        // Cancelled while finishing: don't leave a session behind at Telegram
        await gateway.logout().catch(() => undefined);
        await gateway.cancel().catch(() => undefined);
        return;
      }
      await this.links.updateOne(
        { key: TELEGRAM_LINK_KEY },
        {
          $set: {
            key: TELEGRAM_LINK_KEY,
            sessionCiphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            tag: encrypted.tag,
            account: { id: account.id, name: account.name, username: account.username ?? null, phoneMasked: account.phone ? maskPhone(account.phone) : null },
            linkedAt: new Date(),
            linkedBy: pending.linkedBy,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      this.options.logger.error("Could not finish the Telegram link", error);
      if (this.pending === pending) {
        await gateway.logout().catch(() => undefined);
        await this.cancelPending();
      }
      throw new ServiceError(502, "Koppelen met Telegram is mislukt.");
    }
    clearTimeout(pending.timer);
    this.pending = null;
    this.linkGeneration++;
    this.clearRetry();
    const previous = this.active;
    this.active = gateway;
    await previous?.cancel().catch(() => undefined);
    this.listen(gateway);
    this.options.logger.info(`Telegram linked (${pending.linkedBy ?? "unknown admin"}), listening to @${config.botUsername}`);
  }

  private listen(gateway: TelegramGateway) {
    gateway.onMessage((message) => {
      if (this.active !== gateway) return;
      this.handleMessage(message).catch((error) => this.options.logger.error("Could not handle a Telegram message", error));
    });
    gateway.onRevoked(() => {
      if (this.active !== gateway) return;
      void this.dropRevoked(gateway);
    });
  }

  private async dropRevoked(gateway: TelegramGateway) {
    this.active = null;
    this.linkGeneration++;
    await gateway.cancel().catch(() => undefined);
    await this.links.deleteOne({ key: TELEGRAM_LINK_KEY }).catch((error) => this.options.logger.error("Could not delete the Telegram link", error));
    this.options.logger.warn("The Telegram session was revoked, link removed; an admin has to link Telegram again");
  }

  /** Connect with the stored session; network errors retry with backoff, a revoked session removes the link. */
  private async connectStored(): Promise<void> {
    const config = this.options.config;
    if (!config || this.stopped) return;
    const link = await this.readLink();
    if (!link) return;
    const generation = this.linkGeneration;
    let session: string;
    try {
      session = decryptSession({ ciphertext: link.sessionCiphertext, iv: link.iv, tag: link.tag }, config.sessionKey);
    } catch {
      this.options.logger.warn("Could not decrypt the stored Telegram session (TELEGRAM_SESSION_KEY changed?), link removed; link Telegram again");
      await this.links.deleteOne({ key: TELEGRAM_LINK_KEY });
      return;
    }
    const gateway = this.options.gateway(config);
    try {
      await gateway.connect(session);
    } catch (error) {
      await gateway.cancel().catch(() => undefined);
      if (generation !== this.linkGeneration || this.stopped) return;
      if (error instanceof SessionRevokedError) {
        await this.links.deleteOne({ key: TELEGRAM_LINK_KEY });
        this.options.logger.warn("The stored Telegram session is no longer valid, link removed; an admin has to link Telegram again");
        return;
      }
      const wait = this.retryDelay;
      this.retryDelay = Math.min(wait * 2, this.options.retryMaxMs ?? 5 * 60_000);
      this.options.logger.warn(`Could not connect to Telegram, retrying in ${Math.round(wait / 1000)} s: ${describe(error)}`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connectStored().catch((retryError) => this.options.logger.error("Telegram reconnect failed", retryError));
      }, wait);
      this.retryTimer.unref?.();
      return;
    }
    if (generation !== this.linkGeneration || this.stopped) {
      await gateway.cancel().catch(() => undefined);
      return;
    }
    this.retryDelay = this.options.retryInitialMs ?? 5_000;
    this.active = gateway;
    this.listen(gateway);
    this.options.logger.info(`Telegram connected as ${link.account.name}, listening to @${config.botUsername}`);
  }

  /**
   * The counter-hunt notification for a tegenhunt message, like the former admin button: stored in the current
   * database, then pushed. Once per Telegram message; retried while a demo switch is running.
   */
  private async alertCounterHunt(message: TelegramIncomingMessage) {
    const input = buildTelegramCounterHuntNotification({ telegramId: message.id, text: message.text, date: message.date });
    for (let attempt = 0; attempt < ALERT_ATTEMPTS; attempt++) {
      const generation = currentGeneration();
      const notification = await runTracked(
        async () => {
          if (await AppNotification.exists({ type: "counter-hunt", "data.telegramId": message.id })) return null;
          return AppNotification.create(input);
        },
        { generation },
      );
      if (notification === undefined) {
        await delay(this.options.alertRetryMs ?? 1_000);
        continue;
      }
      if (notification) {
        this.options.logger.info(`Tegenhunt alert sent: ${input.title}`);
        void runTracked(() => sendToAll(notification), { generation });
      }
      return;
    }
    this.options.logger.error(`Tegenhunt alert for Telegram message ${message.id} skipped: a demo switch kept running`);
  }
}

// --- Process instance ---------------------------------------------------------------------------------------------

let instance: TelegramService | null = null;

/** The service of this process; null before startup wiring (index.ts) and in tests that don't set one. */
export function getTelegramService(): TelegramService | null {
  return instance;
}

export function setTelegramService(service: TelegramService | null) {
  instance = service;
}
