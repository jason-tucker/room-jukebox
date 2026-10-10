import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextEpochAfterRestore, nextEpochOnPromote, resolveHub } from './epoch.ts';

const r = (mine: [string, number], theirs: [string, number], theirsVerified = true) =>
  resolveHub({
    mine: { hubId: mine[0], epoch: mine[1] },
    theirs: { hubId: theirs[0], epoch: theirs[1] },
    theirsVerified,
  });

describe('resolveHub', () => {
  it('yields to a verified hub one epoch ahead', () => {
    expect(r(['b', 3], ['a', 4])).toBe('yield');
    expect(r(['a', 3], ['b', 4])).toBe('yield');
  });

  it('ignores jumps beyond mine + 1', () => {
    expect(r(['a', 3], ['b', 5])).toBe('ignore');
    expect(r(['a', 1], ['b', 1000])).toBe('ignore');
  });

  it('keeps against a lower epoch', () => {
    expect(r(['b', 4], ['a', 3])).toBe('keep');
  });

  it('breaks equal epochs by the lower hubId', () => {
    expect(r(['b', 2], ['a', 2])).toBe('yield');
    expect(r(['a', 2], ['b', 2])).toBe('keep');
  });

  it('ignores unverified claims and itself', () => {
    expect(r(['b', 3], ['a', 4], false)).toBe('ignore');
    expect(r(['b', 3], ['a', 3], false)).toBe('ignore');
    expect(r(['a', 3], ['a', 4])).toBe('ignore');
  });

  const claim = fc.record({
    hubId: fc.string({ minLength: 1, maxLength: 8 }),
    epoch: fc.integer({ min: 1, max: 50 }),
  });

  it('property: two verified hubs within one epoch never both keep or both yield', () => {
    fc.assert(
      fc.property(claim, claim, (a, b) => {
        fc.pre(a.hubId !== b.hubId && Math.abs(a.epoch - b.epoch) <= 1);
        const ab = resolveHub({ mine: a, theirs: b, theirsVerified: true });
        const ba = resolveHub({ mine: b, theirs: a, theirsVerified: true });
        expect([ab, ba].sort()).toEqual(['keep', 'yield']);
      }),
    );
  });

  it('property: never yields to an unverified hub, a lower epoch, or a jump over mine + 1', () => {
    fc.assert(
      fc.property(claim, claim, fc.boolean(), (mine, theirs, verified) => {
        const d = resolveHub({ mine, theirs, theirsVerified: verified });
        if (d === 'yield') {
          expect(verified).toBe(true);
          expect(theirs.epoch).toBeGreaterThanOrEqual(mine.epoch);
          expect(theirs.epoch).toBeLessThanOrEqual(mine.epoch + 1);
        }
        if (!verified) expect(d).toBe('ignore');
      }),
    );
  });
});

describe('epoch arithmetic', () => {
  it('restore takes max + 1; promote takes old + 1', () => {
    expect(nextEpochAfterRestore(3, 7)).toBe(8);
    expect(nextEpochAfterRestore(9, 7)).toBe(10);
    expect(nextEpochOnPromote(1)).toBe(2);
  });

  it('property: a restored epoch beats both inputs by exactly one over the max', () => {
    fc.assert(
      fc.property(fc.nat(1e6), fc.nat(1e6), (b, c) => {
        const e = nextEpochAfterRestore(b, c);
        expect(e).toBeGreaterThan(b);
        expect(e).toBeGreaterThan(c);
        expect(e).toBe(Math.max(b, c) + 1);
      }),
    );
  });
});
