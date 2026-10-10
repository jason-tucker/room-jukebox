import type { PrescreenReason } from '@room-jukebox/shared';
import { S } from '../strings.ts';
import type { ApiFailure } from './api.ts';

export interface MessageContext {
  maxPendingPerGuest?: number | null;
  maxDurationSec?: number | null;
}

/** Plain-words verdict for an unplayable video; the text names whose rule it is. */
export function reasonText(
  v: { reason?: PrescreenReason | undefined; message?: string | undefined },
  ctx: MessageContext = {},
): string {
  if (v.reason === 'too-long') return S.reasons['too-long'](ctx.maxDurationSec ?? null);
  if (v.reason) return S.reasons[v.reason];
  return v.message || S.errors.generic;
}

/** Plain-words text for a failed API call. */
export function failureText(err: ApiFailure, ctx: MessageContext = {}): string {
  switch (err.code) {
    case 'network':
      return S.errors.network;
    case 'too-many-pending':
      return S.errors['too-many-pending'](ctx.maxPendingPerGuest ?? null);
    case 'cooldown':
      return S.errors.cooldown(err.retryAfterSec);
    case 'login-throttled':
      return S.errors['login-throttled'](err.retryAfterSec);
    case 'too-long':
      return S.reasons['too-long'](ctx.maxDurationSec ?? null);
    case 'not-found':
    case 'private':
    case 'not-embeddable':
    case 'age-restricted':
    case 'live':
    case 'region-blocked':
      return S.reasons[err.code];
    case 'duplicate':
    case 'queue-full':
    case 'search-budget':
    case 'daily-quota':
    case 'search-disabled':
    case 'bad-password':
    case 'playlist-private':
    case 'playlist-not-found':
    case 'no-api-key':
      return S.errors[err.code];
    case 'forbidden-source':
      return S.errors.forbidden;
    case 'already-set-up':
      return S.errors.setupDone;
    case 'needs-setup':
      return S.errors.needsSetup;
    case 'bad-link':
      return S.guest.notYouTube;
    case 'youtube-unavailable':
      return S.errors.youtubeUnavailable;
    case 'cross-site':
      return S.errors.crossSite;
    default:
      if (err.status === 403) return S.errors.forbidden;
      return err.message || S.errors.generic;
  }
}
