import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideSeek, estimateOffset, expectedPosition } from './sync.ts';

describe('estimateOffset', () => {
  it('returns 0 with no samples', () => {
    expect(estimateOffset([])).toBe(0);
  });

  it('computes t1 - (t0 + t2) / 2 for a single symmetric sample', () => {
    // client sends at 1000, server stamps 6050, client receives at 1100 => offset 5000
    expect(estimateOffset([{ t0: 1000, t1: 6050, t2: 1100 }])).toBe(5000);
  });

  it('takes the median of the last 5 samples, ignoring older ones and outliers', () => {
    const samples = [
      { t0: 0, t1: 99_999, t2: 0 }, // old, outside the window
      { t0: 0, t1: 100, t2: 0 },
      { t0: 0, t1: 101, t2: 0 },
      { t0: 0, t1: 5000, t2: 0 }, // slow-path outlier
      { t0: 0, t1: 102, t2: 0 },
      { t0: 0, t1: 99, t2: 0 },
    ];
    expect(estimateOffset(samples)).toBe(101);
  });

  it('averages the middle two for an even count', () => {
    expect(
      estimateOffset([
        { t0: 0, t1: 10, t2: 0 },
        { t0: 0, t1: 20, t2: 0 },
      ]),
    ).toBe(15);
  });

  it('property: a constant true offset with symmetric delays is recovered exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 500 })), {
          minLength: 1,
          maxLength: 10,
        }),
        (offset, trips) => {
          const samples = trips.map(([t0, oneWay]) => ({
            t0,
            t1: t0 + oneWay + offset,
            t2: t0 + 2 * oneWay,
          }));
          expect(estimateOffset(samples)).toBe(offset);
        },
      ),
    );
  });
});

describe('expectedPosition', () => {
  it('counts elapsed time minus pauses', () => {
    expect(
      expectedPosition({ startedAt: 1000, pausedAt: null, accumulatedPauseMs: 2000 }, 13_000),
    ).toBe(10);
  });

  it('freezes at pausedAt while paused', () => {
    const s = { startedAt: 0, pausedAt: 5000, accumulatedPauseMs: 1000 };
    expect(expectedPosition(s, 5000)).toBe(4);
    expect(expectedPosition(s, 60_000)).toBe(4);
  });

  it('never goes negative (startedAt in the future after clock skew)', () => {
    expect(expectedPosition({ startedAt: 10_000, pausedAt: null, accumulatedPauseMs: 0 }, 0)).toBe(
      0,
    );
  });
});

describe('decideSeek', () => {
  it('does not seek inside the 1.25 s dead band', () => {
    expect(decideSeek({ expected: 10, actual: 11.2, lastSeekAt: null, now: 0 })).toEqual({
      seek: false,
      reason: 'within-dead-band',
    });
    expect(decideSeek({ expected: 10, actual: 8.75, lastSeekAt: null, now: 0 }).seek).toBe(false);
  });

  it('seeks to the expected position when behind or ahead beyond the dead band', () => {
    expect(decideSeek({ expected: 10, actual: 8, lastSeekAt: null, now: 0 })).toEqual({
      seek: true,
      to: 10,
      reason: 'behind',
    });
    expect(decideSeek({ expected: 10, actual: 12, lastSeekAt: null, now: 0 })).toEqual({
      seek: true,
      to: 10,
      reason: 'ahead',
    });
  });

  it('allows at most one seek per 2.5 s', () => {
    expect(decideSeek({ expected: 10, actual: 5, lastSeekAt: 1000, now: 3499 })).toEqual({
      seek: false,
      reason: 'rate-limited',
    });
    expect(decideSeek({ expected: 10, actual: 5, lastSeekAt: 1000, now: 3500 }).seek).toBe(true);
  });

  it('honours custom dead band and interval', () => {
    expect(
      decideSeek({ expected: 10, actual: 11.2, lastSeekAt: null, now: 0, deadBandSec: 1 }).seek,
    ).toBe(true);
    expect(
      decideSeek({ expected: 10, actual: 0, lastSeekAt: 0, now: 600, minSeekIntervalMs: 500 }).seek,
    ).toBe(true);
  });

  it('property: a seek always targets expected and only happens outside the dead band', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3600, noNaN: true }),
        fc.double({ min: 0, max: 3600, noNaN: true }),
        (expected, actual) => {
          const d = decideSeek({ expected, actual, lastSeekAt: null, now: 0 });
          if (d.seek) {
            expect(d.to).toBe(expected);
            expect(Math.abs(actual - expected)).toBeGreaterThan(1.25);
          } else {
            expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1.25);
          }
        },
      ),
    );
  });
});
