import { WrongPasswordError, type TelegramGateway, type TelegramIncomingMessage } from "../services/telegram.service";

/** The session string the fake gateway exports (secret in real life) */
export const SESSION = "mtcute-session-secret";

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

/** TelegramGateway without network: the test resolves `qr`, calls `messageCallback`/`revokedCallback`. */
export class FakeGateway implements TelegramGateway {
  qr = deferred<"linked" | "password">();
  password = "geheim";
  connectError: Error | null = null;
  connectedWith: string | null = null;
  loggedOut = false;
  cancelled = false;
  messageCallback: ((message: TelegramIncomingMessage) => void) | null = null;
  revokedCallback: (() => void) | null = null;

  async startQr(handlers: { onUrl(url: string, expires: Date): void; onScanned(): void }) {
    queueMicrotask(() => handlers.onUrl("tg://login?token=abc", new Date("2026-10-17T20:00:30Z")));
    return this.qr.promise;
  }
  async passwordHint() {
    return "naam van de hond";
  }
  async submitPassword(password: string) {
    if (password !== this.password) throw new WrongPasswordError();
  }
  async me() {
    return { id: 42, name: "Silke", username: "silke", phone: "31612345612" };
  }
  async exportSession() {
    return SESSION;
  }
  async connect(session: string) {
    if (this.connectError) throw this.connectError;
    this.connectedWith = session;
  }
  onMessage(callback: (message: TelegramIncomingMessage) => void) {
    this.messageCallback = callback;
  }
  onRevoked(callback: () => void) {
    this.revokedCallback = callback;
  }
  async logout() {
    this.loggedOut = true;
  }
  async cancel() {
    this.cancelled = true;
  }
}

