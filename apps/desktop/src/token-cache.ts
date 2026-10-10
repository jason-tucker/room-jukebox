/** Owner bearer token held in the main process only; forgotten after `idleMs` without use. */
export class IdleTokenCache {
  private token: string | undefined;
  private lastUse = 0;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(idleMs: number, now: () => number = Date.now) {
    this.idleMs = idleMs;
    this.now = now;
  }

  set(token: string): void {
    this.token = token;
    this.lastUse = this.now();
  }

  /** The token, refreshing the idle timer; `undefined` once it has idled out. */
  get(): string | undefined {
    if (this.expired()) {
      this.token = undefined;
      return undefined;
    }
    this.lastUse = this.now();
    return this.token;
  }

  /** Counts as activity without reading the token (input in the settings window). */
  touch(): void {
    if (this.token !== undefined) this.lastUse = this.now();
  }

  /** True while a token is held but its idle time has run out (the sweep then clears it). */
  expired(): boolean {
    return this.token !== undefined && this.now() - this.lastUse >= this.idleMs;
  }

  has(): boolean {
    return this.token !== undefined && !this.expired();
  }

  /** Drops the token and returns what was held (for a best-effort logout). */
  clear(): string | undefined {
    const token = this.token;
    this.token = undefined;
    return token;
  }
}
