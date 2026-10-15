import { loginBackoff } from '@room-jukebox/core';
import type { Repos } from '../db/repo.ts';

/**
 * Per-source failure throttle with the login backoff (free failures, then exponential), kept in
 * `login_attempts` under `<scope>:<ip>` (M2: player WebSocket proofs).
 */
export class FailureThrottle {
  #repos: Repos;
  #now: () => number;
  #scope: string;

  constructor(repos: Repos, now: () => number, scope: string) {
    this.#repos = repos;
    this.#now = now;
    this.#scope = scope;
  }

  /** ms until `ip` may try again (0 = now). */
  waitMs(ip: string): number {
    const { failures, lastAt } = this.#repos.loginAttempts.get(`${this.#scope}:${ip}`);
    return Math.max(0, lastAt + loginBackoff(failures) - this.#now());
  }

  fail(ip: string): void {
    this.#repos.loginAttempts.fail(`${this.#scope}:${ip}`, this.#now());
  }

  reset(ip: string): void {
    this.#repos.loginAttempts.reset(`${this.#scope}:${ip}`);
  }
}

/** A fixed-window request cap per source (hub challenge). */
export class RateLimit {
  #hits = new Map<string, { start: number; count: number }>();
  #max: number;
  #windowMs: number;
  #now: () => number;

  constructor(max: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Counts a hit; returns the seconds to wait when over the cap, else 0. */
  hit(key: string): number {
    const now = this.#now();
    const h = this.#hits.get(key);
    if (!h || now - h.start >= this.#windowMs) {
      if (this.#hits.size > 1000) this.#hits.clear();
      this.#hits.set(key, { start: now, count: 1 });
      return 0;
    }
    h.count += 1;
    return h.count > this.#max ? Math.ceil((h.start + this.#windowMs - now) / 1000) : 0;
  }
}
