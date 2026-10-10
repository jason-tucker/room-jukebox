import { hmac, safeEqual } from './crypto.ts';

export const GUEST_COOKIE = 'rj_guest';
export const GUEST_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 90;

export interface GuestCookie {
  guestId: string;
  /** ms */
  iat: number;
}

/** `base64url(JSON { guestId, iat }) + "." + base64url(HMAC-SHA256(secret, payload))`. */
export function signGuestCookie(secret: string, value: GuestCookie): string {
  const payload = Buffer.from(JSON.stringify({ guestId: value.guestId, iat: value.iat })).toString(
    'base64url',
  );
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifyGuestCookie(secret: string, raw: string | undefined): GuestCookie | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  if (!safeEqual(raw.slice(dot + 1), hmac(secret, payload))) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as GuestCookie).guestId === 'string' &&
      (v as GuestCookie).guestId.length > 0 &&
      typeof (v as GuestCookie).iat === 'number'
    ) {
      return { guestId: (v as GuestCookie).guestId, iat: (v as GuestCookie).iat };
    }
  } catch {
    // fall through
  }
  return null;
}
