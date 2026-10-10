import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminAuth } from './auth/admin.ts';
import { presentedAdminToken } from './auth/admin.ts';
import { checkHouseholdSource, isLoopback, sourceIp } from './auth/gate.ts';
import {
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE_SEC,
  signGuestCookie,
  verifyGuestCookie,
} from './auth/guest-cookie.ts';
import type { Repos } from './db/repo.ts';
import { HttpError } from './errors.ts';
import type { LanProvider } from './lan.ts';
import { safeAddresses } from './lan.ts';
import type { Session } from './session/session.ts';
import type { SettingsService } from './settings.ts';
import type { YouTubeService } from './youtube/service.ts';
import type { SettingsPublic } from '@room-jukebox/shared';

export interface SetupCompleteInfo {
  /** Long-lived desktop admin token (same as the SetupReply's `token`). */
  token: string;
  /** The hub's own TV player: inject `player=<playerId>&token=<playerToken>` into `/tv`. */
  playerToken: string;
  playerId: string;
}

export interface AppHooks {
  onSetupComplete?: (info: SetupCompleteInfo) => void | Promise<void>;
  onSettingsChanged?: (settings: SettingsPublic) => void | Promise<void>;
}

/** Shared services for route plugins. */
export interface AppContext {
  repos: Repos;
  settings: SettingsService;
  auth: AdminAuth;
  youtube: YouTubeService;
  session: Session;
  lan: LanProvider;
  hooks: AppHooks;
  now: () => number;
  backupDir: string;
  logFile: string | undefined;
  /** Sends a toast to every socket of `guestId`. */
  toastGuest: (guestId: string, level: 'info' | 'warn' | 'error', message: string) => void;
}

export function subnets(lan: LanProvider): string[] {
  return safeAddresses(lan).map((a) => a.cidr);
}

/** Throws 403 `forbidden-source` unless the household source gate allows the request. */
export function requireHousehold(ctx: AppContext, request: FastifyRequest): void {
  const decision = checkHouseholdSource({
    ip: sourceIp(request),
    headers: request.headers,
    subnets: subnets(ctx.lan),
  });
  if (!decision.allowed) {
    request.log.warn({ ip: sourceIp(request), reason: decision.reason }, 'household gate denied');
    throw new HttpError(
      403,
      'forbidden-source',
      'This page only works from the hub itself or the home network.',
    );
  }
}

/** Setup: loopback only (and no proxy headers). */
export function requireLoopback(ctx: AppContext, request: FastifyRequest): void {
  requireHousehold(ctx, request);
  if (!isLoopback(sourceIp(request))) {
    throw new HttpError(403, 'forbidden-source', 'Setup only works on the hub laptop itself.');
  }
}

/**
 * Admin: household gate, then a valid admin session (bearer or `rj_admin` cookie). Cookie-
 * authenticated writes must not come from another site (`Origin` host ≠ `Host`).
 */
export function requireAdmin(ctx: AppContext, request: FastifyRequest): { token: string } {
  requireHousehold(ctx, request);
  const presented = presentedAdminToken(request);
  if (presented === null || !ctx.auth.isValid(presented.token)) {
    throw new HttpError(401, 'unauthorized', 'Sign in as the owner first.');
  }
  if (presented.via === 'cookie' && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let host: string | null;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host === null || host !== request.headers.host) {
        throw new HttpError(403, 'cross-site', 'Owner actions must come from the jukebox page.');
      }
    }
  }
  return { token: presented.token };
}

/** The guest ID from a valid `rj_guest` cookie whose guest still exists (not forgotten). */
export function guestFrom(ctx: AppContext, request: FastifyRequest): string | null {
  const secret = ctx.settings.row().guestSecret;
  const cookie = verifyGuestCookie(secret, request.cookies[GUEST_COOKIE]);
  if (cookie === null) return null;
  const row = ctx.repos.guests.get(cookie.guestId);
  if (row === null || row.forgottenAt !== null) return null;
  return row.guestId;
}

export function setGuestCookie(ctx: AppContext, reply: FastifyReply, guestId: string): void {
  const value = signGuestCookie(ctx.settings.row().guestSecret, { guestId, iat: ctx.now() });
  void reply.setCookie(GUEST_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: GUEST_COOKIE_MAX_AGE_SEC,
  });
}

/** The caller's guest ID, creating a guest (and cookie) when there is none. */
export function ensureGuest(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): string {
  const existing = guestFrom(ctx, request);
  const ip = sourceIp(request);
  if (existing !== null) {
    ctx.repos.guests.setIp(existing, ip);
    return existing;
  }
  const guestId = randomUUID();
  ctx.repos.guests.create(guestId, ip, ctx.now());
  setGuestCookie(ctx, reply, guestId);
  return guestId;
}

/** Runs a desktop hook without letting it break the request. */
export async function runHook(request: FastifyRequest, fn: () => void | Promise<void>) {
  try {
    await fn();
  } catch (err) {
    request.log.error({ err }, 'desktop hook failed');
  }
}
