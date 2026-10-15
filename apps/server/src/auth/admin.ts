import { loginBackoff } from '@room-jukebox/core';
import type { FastifyRequest } from 'fastify';
import type { Repos } from '../db/repo.ts';
import { HttpError } from '../errors.ts';
import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.ts';

export const ADMIN_COOKIE = 'rj_admin';
/** Absolute session lifetime (plan §3.3). */
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
/** The global login counter allows this many more failures than one source before backing off. */
export const GLOBAL_EXTRA_FREE_FAILURES = 15;

export type AdminClient = 'web' | 'desktop';

/** Owner password, login throttle (per source IP and global) and admin sessions. */
export class AdminAuth {
  #repos: Repos;
  #now: () => number;

  constructor(repos: Repos, now: () => number) {
    this.#repos = repos;
    this.#now = now;
  }

  #waitMs(key: string, extraFree: number): number {
    const { failures, lastAt } = this.#repos.loginAttempts.get(key);
    const delay = loginBackoff(Math.max(0, failures - extraFree));
    return Math.max(0, lastAt + delay - this.#now());
  }

  /** ms until `ip` may try again (0 = now). */
  throttleWaitMs(ip: string): number {
    return Math.max(
      this.#waitMs(`ip:${ip}`, 0),
      this.#waitMs('global', GLOBAL_EXTRA_FREE_FAILURES),
    );
  }

  #fail(ip: string): number {
    const now = this.#now();
    this.#repos.loginAttempts.fail(`ip:${ip}`, now);
    this.#repos.loginAttempts.fail('global', now);
    return this.throttleWaitMs(ip);
  }

  /** Throws 429 `login-throttled` or 401 `bad-password`; resets the counters on success. */
  async checkPassword(password: string, ip: string): Promise<void> {
    const wait = this.throttleWaitMs(ip);
    if (wait > 0) {
      throw new HttpError(
        429,
        'login-throttled',
        'Too many wrong passwords. Wait a moment and try again.',
        Math.ceil(wait / 1000),
      );
    }
    const verifier = this.#repos.settings.get()?.passwordVerifier ?? null;
    const ok = verifier !== null && (await verifyPassword(password, verifier));
    if (!ok) {
      const next = this.#fail(ip);
      this.#repos.events.append('admin.login-failed', {}, this.#now());
      throw new HttpError(
        401,
        'bad-password',
        "That password isn't right.",
        next > 0 ? Math.ceil(next / 1000) : undefined,
      );
    }
    this.#repos.loginAttempts.reset(`ip:${ip}`);
    this.#repos.loginAttempts.reset('global');
  }

  async setPassword(password: string): Promise<void> {
    const verifier = await hashPassword(password);
    this.#repos.settings.setPasswordVerifier(verifier, this.#now());
  }

  /**
   * Password change: verifies `current`, stores `next`, runs `beforeInvalidate` (M2: household
   * key rotation and `rekey`), then invalidates every admin session.
   */
  async changePassword(
    current: string,
    next: string,
    ip: string,
    beforeInvalidate?: () => void,
  ): Promise<void> {
    await this.checkPassword(current, ip);
    await this.setPassword(next);
    beforeInvalidate?.();
    this.#repos.adminSessions.deleteAll();
    this.#repos.events.append('admin.password-changed', {}, this.#now());
  }

  /**
   * A new admin session. `longLived` (the desktop token issued at setup) never expires; it is
   * revoked only by a password change.
   */
  createSession(client: AdminClient, longLived = false): string {
    const token = newToken();
    const now = this.#now();
    this.#repos.adminSessions.purgeExpired(now);
    this.#repos.adminSessions.create(
      hashToken(token),
      client,
      now,
      longLived ? null : now + ADMIN_SESSION_MS,
    );
    return token;
  }

  isValid(token: string | undefined | null): boolean {
    if (!token) return false;
    return this.#repos.adminSessions.isValid(hashToken(token), this.#now());
  }

  revoke(token: string): void {
    this.#repos.adminSessions.delete(hashToken(token));
  }
}

/** The admin token presented by a request: `Authorization: Bearer`, else the `rj_admin` cookie. */
export function presentedAdminToken(
  request: FastifyRequest,
): { token: string; via: 'bearer' | 'cookie' } | null {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return { token, via: 'bearer' };
  }
  const cookie = request.cookies[ADMIN_COOKIE];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}
