import { JotiboardLoginError, type JotiboardApi, type JotiboardSession } from "../services/jotiboard.client";
import type { JotiboardHintSolve, JotiboardPin } from "../services/jotiboard.helpers";
import type { JotiboardCounts, JotiboardImporter } from "../services/jotiboard.import";

export const PASSWORD = "secret-pw";

/** JotiboardApi without network. Tokens: "id-<n>" / "rt-<n>", valid for `lifetimeMs` from `now()`. */
export class FakeJotiboardClient implements JotiboardApi {
  calls: string[] = [];
  signInError: Error | null = null;
  refreshError: Error | null = null;
  readError: Error | null = null;
  /** When set, read() waits for it (to hold a poll in flight) */
  readGate: Promise<void> | null = null;
  /** Node values by path */
  data: Record<string, unknown> = { manualLocations: null, hintSolves: null };
  lifetimeMs = 3600_000;
  private counter = 0;

  constructor(private readonly now: () => Date) {}

  private session(): JotiboardSession {
    this.counter++;
    return { idToken: `id-${this.counter}`, refreshToken: `rt-${this.counter}`, uid: "uid-1", expiresAt: new Date(this.now().getTime() + this.lifetimeMs) };
  }

  async signIn(username: string, password: string) {
    this.calls.push(`signIn ${username}`);
    if (this.signInError) throw this.signInError;
    if (password !== PASSWORD) throw new JotiboardLoginError("invalid");
    return this.session();
  }

  async refresh(refreshToken: string) {
    this.calls.push(`refresh ${refreshToken}`);
    if (this.refreshError) throw this.refreshError;
    return this.session();
  }

  async read(path: string, idToken: string) {
    this.calls.push(`read ${path} ${idToken}`);
    if (this.readGate) await this.readGate;
    if (this.readError) throw this.readError;
    return this.data[path] ?? null;
  }
}

/** Records what the service hands the importer. */
export class FakeImporter implements JotiboardImporter {
  pinSnapshots: JotiboardPin[][] = [];
  solveSnapshots: JotiboardHintSolve[][] = [];
  purged = 0;
  current: JotiboardCounts = { pins: 0, hints: 0 };
  importError: Error | null = null;

  async importPins(pins: JotiboardPin[]) {
    if (this.importError) throw this.importError;
    this.pinSnapshots.push(pins);
  }
  async importHintSolves(solves: JotiboardHintSolve[]) {
    if (this.importError) throw this.importError;
    this.solveSnapshots.push(solves);
  }
  async purge() {
    this.purged++;
    const removed = { markers: this.current.pins, hints: this.current.hints };
    this.current = { pins: 0, hints: 0 };
    return removed;
  }
  async counts() {
    return this.current;
  }
}
