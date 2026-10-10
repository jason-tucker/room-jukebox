import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  artistOf,
  EXCLUSION_LADDER,
  pickNext,
  shouldStopRetrying,
  type FallbackVideo,
  type PickNextInput,
} from './fallback.ts';
import type { HistoryEntry } from './queue-machine.ts';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const videos = (n: number, prefix = 'p'): FallbackVideo[] =>
  Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${i}`, title: `Artist ${i} - Song` }));

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function hist(over: Partial<HistoryEntry> & { videoId: string }): HistoryEntry {
  return {
    id: `h-${over.videoId}-${over.enqueuedAt ?? 0}`,
    title: 'Someone - Song',
    requester: { guestId: 'g' },
    source: 'request',
    status: 'done',
    enqueuedAt: NOW - 5 * HOUR,
    endedAt: NOW - 5 * HOUR,
    ...over,
  };
}

const base = (over: Partial<PickNextInput> = {}): PickNextInput => ({
  playlistVideos: [],
  history: [],
  recentlyPlayed: [],
  rng: seeded(1),
  now: NOW,
  ...over,
});

describe('artistOf', () => {
  it('prefers the channel title, else the text before " - "', () => {
    expect(artistOf({ title: 'A - B', channelTitle: 'Chan' })).toBe('chan');
    expect(artistOf({ title: 'Daft Punk - One More Time' })).toBe('daft punk');
    expect(artistOf({ title: 'No separator' })).toBeNull();
    expect(artistOf({ title: ' - leading' })).toBeNull();
  });
});

describe('pickNext', () => {
  it('returns null only for an empty pool', () => {
    expect(pickNext(base())).toBeNull();
    // history entries that are not done requests do not count
    expect(
      pickNext(
        base({
          history: [
            hist({ videoId: 'x', status: 'failed' }),
            hist({ videoId: 'y', status: 'skipped' }),
            hist({ videoId: 'z', source: 'auto', requester: null }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it('pool of 1 always returns it, even when it just played', () => {
    const p = pickNext(base({ playlistVideos: videos(1), recentlyPlayed: ['p0'] }));
    expect(p).toMatchObject({ videoId: 'p0', excludedWindow: 0, origin: 'playlist' });
  });

  it('pool of 3 never repeats the last track and relaxes the window', () => {
    for (let seed = 0; seed < 50; seed++) {
      const p = pickNext(
        base({ playlistVideos: videos(3), recentlyPlayed: ['p0', 'p1', 'p2'], rng: seeded(seed) }),
      );
      expect(p?.videoId).not.toBe('p2');
      expect(p?.excludedWindow).toBe(1);
    }
    const p = pickNext(base({ playlistVideos: videos(3), recentlyPlayed: ['p1', 'p2'] }));
    expect(p).toMatchObject({ videoId: 'p0', excludedWindow: 20 });
  });

  it('pool of 20 relaxes to 10 when all 20 played recently', () => {
    const pool = videos(20);
    const recent = pool.map((v) => v.videoId);
    for (let seed = 0; seed < 50; seed++) {
      const p = pickNext(base({ playlistVideos: pool, recentlyPlayed: recent, rng: seeded(seed) }));
      expect(p?.excludedWindow).toBe(10);
      expect(recent.slice(-10)).not.toContain(p?.videoId);
    }
  });

  it('pool of 500 excludes the last 20 and covers the rest', () => {
    const pool = videos(500);
    const recent = pool.slice(0, 40).map((v) => v.videoId);
    const seen = new Set<string>();
    const rng = seeded(7);
    for (let i = 0; i < 3000; i++) {
      const p = pickNext(base({ playlistVideos: pool, recentlyPlayed: recent, rng }));
      expect(p?.excludedWindow).toBe(20);
      expect(recent.slice(-20)).not.toContain(p?.videoId);
      seen.add(p?.videoId as string);
    }
    expect(seen.has('p0')).toBe(true); // played 40 tracks ago, eligible again
    expect(seen.size).toBeGreaterThan(400);
  });

  it('walks the relax ladder 20 → 10 → 5 → 1 → 0', () => {
    expect(EXCLUSION_LADDER).toEqual([20, 10, 5, 1, 0]);
    const cases: [number, number][] = [
      [25, 20],
      [15, 10],
      [8, 5],
      [3, 1],
      [1, 0],
    ];
    for (const [size, window] of cases) {
      const pool = videos(size);
      const p = pickNext(
        base({
          playlistVideos: pool,
          recentlyPlayed: pool.map((v) => v.videoId).concat(pool.map((v) => v.videoId)),
        }),
      );
      // with every pool video in the last `size` plays, the widest window leaving a candidate wins
      expect([size, p?.excludedWindow]).toEqual([size, window]);
    }
  });

  it('unions playlist videos and done requests, deduplicated by video ID', () => {
    const history = [hist({ videoId: 'p0' }), hist({ videoId: 'h1', channelTitle: 'C' })];
    const seenIds = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const p = pickNext(base({ playlistVideos: videos(1), history, rng: seeded(seed) }));
      seenIds.add(`${p?.videoId}:${p?.origin}`);
    }
    expect(seenIds).toEqual(new Set(['p0:playlist', 'h1:history']));
  });

  it('weighs recently requested artists and tracks double', () => {
    const pool: FallbackVideo[] = [
      { videoId: 'a', title: 'Hot Artist - Other Song' },
      { videoId: 'b', title: 'Cold - Song' },
      { videoId: 'c', title: 'Whatever', channelTitle: 'Hot Channel' },
      { videoId: 'd', title: 'Cold2 - Song' },
    ];
    const history = [
      hist({ videoId: 'zz', title: 'Hot Artist - Requested', enqueuedAt: NOW - HOUR }),
      hist({ videoId: 'yy', title: 'x', channelTitle: 'Hot Channel', enqueuedAt: NOW - HOUR }),
      hist({ videoId: 'd', title: 'Cold2 - Song', enqueuedAt: NOW - 3 * HOUR }), // too old
    ];
    const weights: Record<string, number> = {};
    for (let seed = 0; seed < 50; seed++) {
      const p = pickNext(base({ playlistVideos: pool, history, rng: seeded(seed) }));
      if (p) weights[p.videoId] = p.weight;
    }
    expect(weights.a).toBe(2);
    expect(weights.c).toBe(2);
    expect(weights.b).toBe(1);
    expect(weights.d).toBe(1);
    const at = (r: number) =>
      pickNext(base({ playlistVideos: pool, history, rng: () => r }))?.videoId;
    // pool = a b c d (playlist) + zz yy (done requests; d deduped): weights 2 1 2 1 2 2, total 10
    expect(at(0)).toBe('a');
    expect(at(0.19)).toBe('a');
    expect(at(0.2)).toBe('b');
    expect(at(0.3)).toBe('c');
    expect(at(0.5)).toBe('d');
    expect(at(0.6)).toBe('zz');
    expect(at(0.999)).toBe('yy');
  });

  it('property: never null for a non-empty pool, always from the pool, deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.array(fc.integer({ min: 0, max: 80 }), { maxLength: 40 }),
        fc.integer(),
        (size, recentIdx, seed) => {
          const pool = videos(size);
          const recent = recentIdx.map((i) => `p${i}`);
          const a = pickNext(
            base({ playlistVideos: pool, recentlyPlayed: recent, rng: seeded(seed) }),
          );
          const b = pickNext(
            base({ playlistVideos: pool, recentlyPlayed: recent, rng: seeded(seed) }),
          );
          expect(a).not.toBeNull();
          expect(a).toEqual(b);
          expect(pool.map((v) => v.videoId)).toContain(a?.videoId);
          if (size >= 2 && recent.length > 0) expect(a?.videoId).not.toBe(recent.at(-1));
          const window = a?.excludedWindow ?? 0;
          if (window > 0) expect(recent.slice(-window)).not.toContain(a?.videoId);
        },
      ),
    );
  });
});

describe('shouldStopRetrying', () => {
  it('stops at the limit (default 5)', () => {
    expect(shouldStopRetrying(4)).toBe(false);
    expect(shouldStopRetrying(5)).toBe(true);
    expect(shouldStopRetrying(2, 2)).toBe(true);
    expect(shouldStopRetrying(0)).toBe(false);
  });
});
