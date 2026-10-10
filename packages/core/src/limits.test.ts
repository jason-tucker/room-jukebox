import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  checkSearchBudget,
  DEFAULT_LIMITS,
  emptySearchUsage,
  formatLimitDuration,
  loginBackoff,
  recordSearch,
  remainingSearches,
  type Limits,
  type RequestCheckInput,
  type SearchActor,
} from './limits.ts';

const req = (over: Partial<RequestCheckInput> = {}): RequestCheckInput => ({
  guestId: 'g1',
  ip: '192.168.1.10',
  videoId: 'v1',
  durationSec: 200,
  now: 100_000,
  pendingByGuest: {},
  lastRequestAtByGuest: {},
  queuedVideoIds: [],
  ...over,
});

const L: Limits = DEFAULT_LIMITS;

describe('defaults', () => {
  it('match the plan', () => {
    expect(L).toEqual({
      maxPendingPerGuest: 5,
      cooldownSec: 5,
      allowDuplicates: true,
      maxDurationSec: 480,
      search: {
        perGuestPerDay: 10,
        perGuestIntervalSec: 15,
        perIpPerDay: 10,
        publicPerDay: 20,
        ownerReserve: 20,
        dailyTotal: 100,
      },
    });
  });
});

describe('formatLimitDuration', () => {
  it('formats whole minutes and leftovers', () => {
    expect(formatLimitDuration(480)).toBe('8-minute');
    expect(formatLimitDuration(450)).toBe('7 min 30 s');
    expect(formatLimitDuration(45)).toBe('45-second');
  });
});

describe('checkRequest', () => {
  it('accepts a normal request', () => {
    expect(checkRequest(L, req())).toEqual({ ok: true });
    expect(checkRequest(L, req({ durationSec: undefined }))).toEqual({ ok: true });
  });

  it('refuses over-length videos naming the owner rule', () => {
    expect(checkRequest(L, req({ durationSec: 481 }))).toEqual({
      ok: false,
      reason: 'too-long',
      message: "This song is over this room's 8-minute limit, set by the owner.",
    });
    expect(checkRequest(L, req({ durationSec: 480 })).ok).toBe(true);
  });

  it('refuses duplicates only when the owner disallows them', () => {
    const input = req({ queuedVideoIds: new Set(['v0', 'v1']) });
    expect(checkRequest(L, input).ok).toBe(true);
    const r = checkRequest({ ...L, allowDuplicates: false }, input);
    expect(r).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(!r.ok && r.message).toContain('set by the owner');
  });

  it('caps pending requests per guest (and per IP when given)', () => {
    const r = checkRequest(L, req({ pendingByGuest: { g1: 5 } }));
    expect(r).toMatchObject({ ok: false, reason: 'too-many-pending' });
    expect(!r.ok && r.message).toContain('allows 5 per guest');
    expect(checkRequest(L, req({ pendingByGuest: { g1: 4, g2: 9 } })).ok).toBe(true);
    expect(checkRequest(L, req({ pendingByIp: { '192.168.1.10': 5 } }))).toMatchObject({
      reason: 'too-many-pending',
    });
  });

  it('enforces the cooldown with a retry-after', () => {
    const r = checkRequest(L, req({ lastRequestAtByGuest: { g1: 96_500 } }));
    expect(r).toMatchObject({ ok: false, reason: 'cooldown', retryAfterSec: 2 });
    expect(!r.ok && r.message).toBe(
      'Please wait 2 seconds; this room allows one request every 5 seconds (set by the owner).',
    );
    expect(checkRequest(L, req({ lastRequestAtByGuest: { g1: 95_000 } })).ok).toBe(true);
    expect(checkRequest(L, req({ lastRequestAtByIp: { '192.168.1.10': 99_000 } })).ok).toBe(false);
  });
});

const guest = (over: Partial<SearchActor> = {}): SearchActor => ({
  guestId: 'g1',
  ip: '10.0.0.1',
  isOwner: false,
  isPublic: false,
  now: 1_000_000,
  ...over,
});

describe('checkSearchBudget', () => {
  it('allows a fresh guest and records usage', () => {
    const u = emptySearchUsage();
    expect(checkSearchBudget(L, u, guest())).toEqual({ ok: true });
    const u2 = recordSearch(u, guest({ isPublic: true }));
    expect(u2).toMatchObject({ total: 1, public: 1, byGuest: { g1: 1 }, byIp: { '10.0.0.1': 1 } });
    expect(u.total).toBe(0);
  });

  it('enforces the per-guest interval, per-guest and per-IP daily caps', () => {
    let u = recordSearch(emptySearchUsage(), guest());
    expect(checkSearchBudget(L, u, guest({ now: 1_010_000 }))).toMatchObject({
      reason: 'interval',
      retryAfterSec: 5,
    });
    expect(checkSearchBudget(L, u, guest({ now: 1_015_000 })).ok).toBe(true);
    // another guest on the same IP shares the interval
    expect(checkSearchBudget(L, u, guest({ guestId: 'g2', now: 1_001_000 })).ok).toBe(false);
    u = { ...u, byGuest: { g1: 10 }, lastAtByGuest: {}, lastAtByIp: {} };
    expect(checkSearchBudget(L, u, guest())).toMatchObject({ reason: 'guest-daily' });
    u = { ...u, byGuest: {}, byIp: { '10.0.0.1': 10 } };
    expect(checkSearchBudget(L, u, guest())).toMatchObject({ reason: 'ip-daily' });
  });

  it('applies the smaller public budget only to the public listener', () => {
    const u = { ...emptySearchUsage(), total: 20, public: 20 };
    expect(checkSearchBudget(L, u, guest({ isPublic: true }))).toMatchObject({
      reason: 'public-daily',
    });
    expect(checkSearchBudget(L, u, guest()).ok).toBe(true);
  });

  it('keeps the last 20 of 100 for the owner', () => {
    const u = { ...emptySearchUsage(), total: 80 };
    const r = checkSearchBudget(L, u, guest());
    expect(r).toMatchObject({ ok: false, reason: 'owner-reserve' });
    expect(!r.ok && r.message).toContain('Find on YouTube');
    expect(checkSearchBudget(L, u, guest({ isOwner: true })).ok).toBe(true);
    const spent = { ...u, total: 100 };
    expect(checkSearchBudget(L, spent, guest({ isOwner: true }))).toMatchObject({
      reason: 'daily-quota',
    });
  });

  it('remainingSearches splits guest and owner', () => {
    expect(remainingSearches({ total: 0 }, L)).toEqual({ guests: 80, owner: 100 });
    expect(remainingSearches({ total: 90 }, L)).toEqual({ guests: 0, owner: 10 });
    expect(remainingSearches({ total: 150 }, L)).toEqual({ guests: 0, owner: 0 });
  });

  it('property: guests never spend the owner reserve; the total never exceeds the daily cap', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            guest: fc.integer({ min: 0, max: 40 }),
            ip: fc.integer({ min: 0, max: 40 }),
            isOwner: fc.boolean(),
            isPublic: fc.boolean(),
            dt: fc.integer({ min: 0, max: 60_000 }),
          }),
          { maxLength: 300 },
        ),
        (attempts) => {
          let usage = emptySearchUsage();
          let guestSpent = 0;
          let now = 0;
          for (const a of attempts) {
            now += a.dt;
            const actor = {
              guestId: `g${a.guest}`,
              ip: `ip${a.ip}`,
              isOwner: a.isOwner,
              isPublic: a.isPublic,
              now,
            };
            if (checkSearchBudget(L, usage, actor).ok) {
              if (!a.isOwner) {
                guestSpent++;
                // a guest search never starts inside the reserve
                expect(usage.total).toBeLessThan(L.search.dailyTotal - L.search.ownerReserve);
              }
              usage = recordSearch(usage, actor);
            }
          }
          expect(guestSpent).toBeLessThanOrEqual(L.search.dailyTotal - L.search.ownerReserve);
          expect(usage.total).toBeLessThanOrEqual(L.search.dailyTotal);
          expect(usage.public).toBeLessThanOrEqual(
            L.search.publicPerDay + attempts.filter((a) => a.isOwner && a.isPublic).length,
          );
        },
      ),
    );
  });
});

describe('loginBackoff', () => {
  it('is free for fewer than 5 failures, then doubles from 1 s to a 15 min cap', () => {
    expect([0, 1, 4].map(loginBackoff)).toEqual([0, 0, 0]);
    expect([5, 6, 7, 10].map(loginBackoff)).toEqual([1000, 2000, 4000, 32_000]);
    expect(loginBackoff(100)).toBe(15 * 60 * 1000);
    expect(loginBackoff(1e9)).toBe(15 * 60 * 1000);
  });

  it('property: monotonic non-decreasing', () => {
    fc.assert(
      fc.property(fc.nat(1000), (n) => {
        expect(loginBackoff(n + 1)).toBeGreaterThanOrEqual(loginBackoff(n));
      }),
    );
  });
});
