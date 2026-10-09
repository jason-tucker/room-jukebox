import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEnded } from './transition.ts';

interface S {
  revision: number;
  cursor: number;
}
const advance = (s: S): S => ({ ...s, cursor: s.cursor + 1 });

describe('applyEnded', () => {
  it('commits when the revision matches and bumps it once', () => {
    const r = applyEnded({ revision: 3, cursor: 0 }, 3, advance);
    expect(r).toEqual({ committed: true, state: { revision: 4, cursor: 1 } });
  });

  it('ignores a stale or future revision and returns the same state object', () => {
    const s = { revision: 3, cursor: 0 };
    expect(applyEnded(s, 2, advance)).toEqual({ committed: false, state: s });
    expect(applyEnded(s, 4, advance).state).toBe(s);
  });

  it('a duplicate ended (same revision twice) advances exactly once', () => {
    const first = applyEnded({ revision: 0, cursor: 0 }, 0, advance);
    const second = applyEnded(first.state, 0, advance);
    expect(second.committed).toBe(false);
    expect(second.state).toEqual({ revision: 1, cursor: 1 });
  });

  it('property: duplicate, late and interleaved reports never double-advance', () => {
    // Each "track" k (revision k) is ended by N players, each possibly reporting several times, and
    // all reports for already-finished tracks may be replayed late in any order.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 40 }),
        (reportsPerTrack, lateRevisions) => {
          let state: S = { revision: 0, cursor: 0 };
          let commits = 0;
          for (const reports of reportsPerTrack) {
            const seen = state.revision;
            for (let i = 0; i < reports; i++) {
              const r = applyEnded(state, seen, advance);
              if (r.committed) commits++;
              state = r.state;
            }
            for (const late of lateRevisions) {
              if (late >= state.revision) continue; // only replay revisions already passed
              const r = applyEnded(state, late, advance);
              expect(r.committed).toBe(false);
              state = r.state;
            }
          }
          expect(commits).toBe(reportsPerTrack.length);
          expect(state.revision).toBe(reportsPerTrack.length);
          expect(state.cursor).toBe(reportsPerTrack.length);
        },
      ),
    );
  });

  it('property: over any event sequence, revision === cursor === number of commits', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -2, max: 2 })), (deltas) => {
        let state: S = { revision: 0, cursor: 0 };
        let commits = 0;
        for (const d of deltas) {
          const r = applyEnded(state, state.revision + d, advance);
          if (r.committed) {
            commits++;
            expect(d).toBe(0);
          }
          state = r.state;
        }
        expect(state.revision).toBe(commits);
        expect(state.cursor).toBe(commits);
      }),
    );
  });
});
