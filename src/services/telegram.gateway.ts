import { MemoryStorage, TelegramClient, tl, type Message } from "@mtcute/bun";
import { logger } from "../logger";
import { SessionRevokedError, WrongPasswordError, type TelegramConfig, type TelegramGateway, type TelegramIncomingMessage } from "./telegram.service";

/** RPC errors that mean the session is gone for good (logged out elsewhere, account deleted or banned). */
const REVOKED_ERRORS = new Set(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "AUTH_KEY_INVALID", "AUTH_KEY_DUPLICATED"]);
const isRevoked = (error: unknown) => tl.RpcError.is(error) && REVOKED_ERRORS.has(error.text);

/**
 * mtcute stops its updates loop silently when the session is revoked, so the session is checked now and then
 * (one users.getUsers call).
 */
const HEALTH_CHECK_MS = 5 * 60_000;
/** mtcute's own log level: errors and warnings only (it logs to the console) */
const MTCUTE_LOG_WARN = 2;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const toIncoming = (message: Message): TelegramIncomingMessage => {
  const { sender, chat } = message;
  return {
    id: message.id,
    senderUsername: "username" in sender ? (sender.username ?? undefined) : undefined,
    senderIsBot: sender.type === "user" && sender.isBot,
    // A private chat is the chat with the sender itself (not a group or channel the bot posts in)
    privateChat: chat.type === "user" && chat.id === sender.id,
    text: message.text ?? "",
    date: message.date,
  };
};

/**
 * TelegramGateway on mtcute: an in-memory storage (the session lives encrypted in Mongo, see telegram.service.ts),
 * QR login with signInQr, and new messages from the updates loop. One client per gateway; `cancel()` destroys it.
 */
export class MtcuteTelegramGateway implements TelegramGateway {
  private readonly client: TelegramClient;
  private readonly abort = new AbortController();
  private messageCallback: ((message: TelegramIncomingMessage) => void) | null = null;
  private revokedCallback: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** The 2FA password the running signInQr waits for (set by submitPassword) */
  private passwordRequest: Deferred<string> | null = null;
  /** Settles the running submitPassword call: resolved when logged in, rejected on a wrong password */
  private passwordResult: Deferred<void> | null = null;
  private login: Promise<unknown> | null = null;
  private readonly botUsername: string;

  constructor(config: TelegramConfig) {
    this.botUsername = config.botUsername;
    this.client = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: new MemoryStorage(),
      logLevel: MTCUTE_LOG_WARN,
      initConnectionOptions: { deviceModel: "Jotihunt tracker", appVersion: "1.0" },
    });
    // Errors of the updates loop and connections; a revoked session ends the link
    this.client.onError.add((error) => {
      if (isRevoked(error)) this.revokedCallback?.();
      else logger.warn(`Telegram client error: ${error.message}`);
    });
    this.client.onNewMessage.add((message) => {
      if (!message.isOutgoing) this.messageCallback?.(toIncoming(message));
    });
  }

  startQr(handlers: { onUrl(url: string, expires: Date): void; onScanned(): void }): Promise<"linked" | "password"> {
    const outcome = deferred<"linked" | "password">();
    this.login = this.client
      .signInQr({
        onUrlUpdated: (url, expires) => handlers.onUrl(url, expires),
        onQrScanned: () => handlers.onScanned(),
        // Called when the account has a 2FA password (again after a wrong one): wait for submitPassword
        password: () => {
          this.passwordRequest = deferred<string>();
          outcome.resolve("password");
          return this.passwordRequest.promise;
        },
        invalidPasswordCallback: () => {
          this.passwordResult?.reject(new WrongPasswordError());
          this.passwordResult = null;
        },
        abortSignal: this.abort.signal,
      })
      .then(() => {
        outcome.resolve("linked");
        this.passwordResult?.resolve();
        this.passwordResult = null;
        this.startHealthCheck();
      })
      .catch((error) => {
        outcome.reject(error);
        this.passwordResult?.reject(error);
        this.passwordResult = null;
      });
    return outcome.promise;
  }

  async passwordHint(): Promise<string | null> {
    return this.client.getPasswordHint();
  }

  submitPassword(password: string): Promise<void> {
    const request = this.passwordRequest;
    if (!request) return Promise.reject(new Error("No password requested"));
    this.passwordRequest = null;
    this.passwordResult = deferred<void>();
    const result = this.passwordResult.promise;
    request.resolve(password);
    return result;
  }

  async me() {
    const me = await this.client.getMe();
    return { id: me.id, name: me.displayName, username: me.username ?? undefined, phone: me.phoneNumber ?? undefined };
  }

  exportSession(): Promise<string> {
    return this.client.exportSession();
  }

  async connect(session: string): Promise<void> {
    await this.client.importSession(session, true);
    try {
      const me = await this.client.getMe();
      // Starts the updates loop (new messages); same as what client.start() does after getMe
      await this.client.notifyLoggedIn(me.raw);
    } catch (error) {
      if (isRevoked(error)) throw new SessionRevokedError();
      throw error;
    }
    this.startHealthCheck();
  }

  onMessage(callback: (message: TelegramIncomingMessage) => void) {
    this.messageCallback = callback;
  }

  /** The private chat with the bot, newest first (resolves the username once, then mtcute caches the peer). */
  async recentBotMessages(limit: number): Promise<TelegramIncomingMessage[]> {
    const history = await this.client.getHistory(this.botUsername, { limit });
    return history.filter((message) => !message.isOutgoing).map(toIncoming);
  }

  onRevoked(callback: () => void) {
    this.revokedCallback = callback;
  }

  async logout(): Promise<void> {
    await this.client.logOut();
  }

  async cancel(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.messageCallback = null;
    this.revokedCallback = null;
    this.abort.abort();
    this.passwordRequest?.reject(new Error("Login cancelled"));
    this.passwordRequest = null;
    await this.client.destroy();
    await this.login?.catch(() => undefined);
  }

  private startHealthCheck() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.client.getMe().catch((error) => {
        if (isRevoked(error)) this.revokedCallback?.();
      });
    }, HEALTH_CHECK_MS);
    this.healthTimer.unref?.();
  }
}

export const createMtcuteGateway = (config: TelegramConfig): TelegramGateway => new MtcuteTelegramGateway(config);
