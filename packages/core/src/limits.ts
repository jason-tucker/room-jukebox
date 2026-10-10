/**
 * Request limits, search budgets and the login throttle (plan §0 "Guests and admin", §3.3).
 * All values come from settings; the functions are pure and take `now` (ms) from the caller.
 * Messages are plain English and say whose rule it is (the owner's or YouTube's).
 */

export interface SearchLimits {
  /** Cache-miss searches one guest may make per day. */
  perGuestPerDay: number;
  /** Minimum seconds between searches from one guest (and from one IP). */
  perGuestIntervalSec: number;
  perIpPerDay: number;
  /** Shared daily budget for searches arriving through the public listener. */
  publicPerDay: number;
  /** The last N of the daily total that only the owner can spend. */
  ownerReserve: number;
  /** YouTube's `search.list` bucket per project per day. */
  dailyTotal: number;
}

export interface Limits {
  maxPendingPerGuest: number;
  cooldownSec: number;
  allowDuplicates: boolean;
  maxDurationSec: number;
  search: SearchLimits;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxPendingPerGuest: 5,
  cooldownSec: 5,
  allowDuplicates: true,
  maxDurationSec: 480,
  search: Object.freeze({
    perGuestPerDay: 10,
    perGuestIntervalSec: 15,
    perIpPerDay: 10,
    publicPerDay: 20,
    ownerReserve: 20,
    dailyTotal: 100,
  }),
});

/** "8-minute", "7 min 30 s" — for messages. */
export function formatLimitDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (s === 0) return `${m}-minute`;
  if (m === 0) return `${s}-second`;
  return `${m} min ${s} s`;
}

export function tooLongMessage(maxDurationSec: number): string {
  return `This song is over this room's ${formatLimitDuration(maxDurationSec)} limit, set by the owner.`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type RequestRejection = 'too-many-pending' | 'cooldown' | 'duplicate' | 'too-long';

export type LimitCheck<R extends string> =
  { ok: true } | { ok: false; reason: R; message: string; retryAfterSec?: number };

export interface RequestCheckInput {
  guestId: string;
  ip: string;
  videoId: string;
  /** Unknown (undefined) skips the length rule; the pre-screen or play time catches it. */
  durationSec?: number;
  now: number;
  /** Queued (not yet played) requests per guest ID. */
  pendingByGuest: Readonly<Record<string, number>>;
  /** ms of each guest's last accepted request. */
  lastRequestAtByGuest: Readonly<Record<string, number>>;
  /** Video IDs now playing or queued. */
  queuedVideoIds: Iterable<string>;
  /** Optional per-IP counters; when given the same pending and cooldown rules apply per IP. */
  pendingByIp?: Readonly<Record<string, number>>;
  lastRequestAtByIp?: Readonly<Record<string, number>>;
}

/** Checks a request against the room's limits, in the order: length, duplicate, pending, cooldown. */
export function checkRequest(
  limits: Limits,
  input: RequestCheckInput,
): LimitCheck<RequestRejection> {
  if (input.durationSec !== undefined && input.durationSec > limits.maxDurationSec) {
    return { ok: false, reason: 'too-long', message: tooLongMessage(limits.maxDurationSec) };
  }
  if (!limits.allowDuplicates) {
    for (const id of input.queuedVideoIds) {
      if (id === input.videoId) {
        return {
          ok: false,
          reason: 'duplicate',
          message:
            "This song is already in the queue, and this room doesn't allow duplicates (set by the owner).",
        };
      }
    }
  }
  const pending = Math.max(
    input.pendingByGuest[input.guestId] ?? 0,
    input.pendingByIp?.[input.ip] ?? 0,
  );
  if (pending >= limits.maxPendingPerGuest) {
    return {
      ok: false,
      reason: 'too-many-pending',
      message: `You already have ${plural(pending, 'song')} waiting; this room allows ${limits.maxPendingPerGuest} per guest (set by the owner). Try again after one plays.`,
    };
  }
  const last = Math.max(
    input.lastRequestAtByGuest[input.guestId] ?? -Infinity,
    input.lastRequestAtByIp?.[input.ip] ?? -Infinity,
  );
  const waitMs = last + limits.cooldownSec * 1000 - input.now;
  if (waitMs > 0) {
    const retryAfterSec = Math.ceil(waitMs / 1000);
    return {
      ok: false,
      reason: 'cooldown',
      message: `Please wait ${plural(retryAfterSec, 'second')}; this room allows one request every ${plural(limits.cooldownSec, 'second')} (set by the owner).`,
      retryAfterSec,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Search budget

/**
 * Today's cache-miss search counters (the caller resets them at midnight Pacific, when YouTube's
 * bucket resets, and records a search only when it actually called `search.list`).
 */
export interface SearchUsage {
  /** All cache misses today, owner included (both laptops share the bucket). */
  total: number;
  byGuest: Readonly<Record<string, number>>;
  byIp: Readonly<Record<string, number>>;
  /** Cache misses that came through the public listener. */
  public: number;
  /** ms of the last search per guest / per IP. */
  lastAtByGuest: Readonly<Record<string, number>>;
  lastAtByIp: Readonly<Record<string, number>>;
}

export const emptySearchUsage = (): SearchUsage => ({
  total: 0,
  byGuest: {},
  byIp: {},
  public: 0,
  lastAtByGuest: {},
  lastAtByIp: {},
});

export interface SearchActor {
  guestId: string;
  ip: string;
  isOwner: boolean;
  isPublic: boolean;
  now: number;
}

export type SearchRejection =
  'daily-quota' | 'owner-reserve' | 'public-daily' | 'guest-daily' | 'ip-daily' | 'interval';

const USE_FIND = 'Use Find on YouTube instead, it always works.';

/**
 * May this actor spend one search now? Call it only for a cache miss. The owner may spend the
 * whole daily total; guests stop `ownerReserve` short of it, then per-public, per-guest, per-IP
 * daily caps and the per-guest/per-IP interval apply.
 */
export function checkSearchBudget(
  limits: Limits,
  usage: SearchUsage,
  actor: SearchActor,
): LimitCheck<SearchRejection> {
  const s = limits.search;
  if (usage.total >= s.dailyTotal) {
    return {
      ok: false,
      reason: 'daily-quota',
      message: `Search is used up for today (YouTube allows ${s.dailyTotal} searches a day). ${USE_FIND}`,
    };
  }
  if (actor.isOwner) return { ok: true };
  if (usage.total >= s.dailyTotal - s.ownerReserve) {
    return {
      ok: false,
      reason: 'owner-reserve',
      message: `Search is used up for guests today; the last ${s.ownerReserve} are kept for the owner. ${USE_FIND}`,
    };
  }
  if (actor.isPublic && usage.public >= s.publicPerDay) {
    return {
      ok: false,
      reason: 'public-daily',
      message: `Search from outside the house is used up for today (${s.publicPerDay} a day, set by the owner). ${USE_FIND}`,
    };
  }
  if ((usage.byGuest[actor.guestId] ?? 0) >= s.perGuestPerDay) {
    return {
      ok: false,
      reason: 'guest-daily',
      message: `You've used your ${s.perGuestPerDay} searches for today (set by the owner). ${USE_FIND}`,
    };
  }
  if ((usage.byIp[actor.ip] ?? 0) >= s.perIpPerDay) {
    return {
      ok: false,
      reason: 'ip-daily',
      message: `This device has used its ${s.perIpPerDay} searches for today (set by the owner). ${USE_FIND}`,
    };
  }
  const last = Math.max(
    usage.lastAtByGuest[actor.guestId] ?? -Infinity,
    usage.lastAtByIp[actor.ip] ?? -Infinity,
  );
  const waitMs = last + s.perGuestIntervalSec * 1000 - actor.now;
  if (waitMs > 0) {
    const retryAfterSec = Math.ceil(waitMs / 1000);
    return {
      ok: false,
      reason: 'interval',
      message: `Please wait ${plural(retryAfterSec, 'second')} before searching again; this room allows one search every ${plural(s.perGuestIntervalSec, 'second')} (set by the owner).`,
      retryAfterSec,
    };
  }
  return { ok: true };
}

/** Returns usage with one cache-miss search by `actor` recorded. */
export function recordSearch(usage: SearchUsage, actor: SearchActor): SearchUsage {
  return {
    total: usage.total + 1,
    byGuest: { ...usage.byGuest, [actor.guestId]: (usage.byGuest[actor.guestId] ?? 0) + 1 },
    byIp: { ...usage.byIp, [actor.ip]: (usage.byIp[actor.ip] ?? 0) + 1 },
    public: usage.public + (actor.isPublic ? 1 : 0),
    lastAtByGuest: { ...usage.lastAtByGuest, [actor.guestId]: actor.now },
    lastAtByIp: { ...usage.lastAtByIp, [actor.ip]: actor.now },
  };
}

/** Searches left today: `guests` excludes the owner reserve, `owner` is the whole remainder. */
export function remainingSearches(
  usage: Pick<SearchUsage, 'total'>,
  limits: Limits,
): { guests: number; owner: number } {
  const s = limits.search;
  return {
    guests: Math.max(0, s.dailyTotal - s.ownerReserve - usage.total),
    owner: Math.max(0, s.dailyTotal - usage.total),
  };
}

/** The guest page warns ("search is almost used up") at or below this many guest searches left. */
export const SEARCH_LOW_WARNING = 10;

// ---------------------------------------------------------------------------------------------
// Login throttle

export const LOGIN_FREE_FAILURES = 5;
export const LOGIN_BACKOFF_BASE_MS = 1000;
export const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Delay before the next login attempt from one source after `failures` consecutive failures:
 * 0 for fewer than 5, then 1 s, 2 s, 4 s, … capped at 15 minutes.
 */
export function loginBackoff(failures: number): number {
  if (failures < LOGIN_FREE_FAILURES) return 0;
  const exp = failures - LOGIN_FREE_FAILURES;
  if (exp >= 30) return LOGIN_BACKOFF_MAX_MS;
  return Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** exp, LOGIN_BACKOFF_MAX_MS);
}
