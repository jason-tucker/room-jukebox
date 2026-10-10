import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  emptyQueueState,
  enqueueAuto,
  enqueueRequest,
  ownerSkip,
  remove,
  reorder,
  restoreAfterRestart,
  transition,
  type QueueState,
} from './queue-machine.ts';

const guest = (guestId: string) => ({ guestId });

function req(state: QueueState, key: string, now = 0, videoId = `v-${key}`) {
  return enqueueRequest(state, {
    videoId,
    title: `Title ${key}`,
    requester: guest('g1'),
    idempotencyKey: key,
    now,
  });
}

function auto(state: QueueState, id: string, now = 0) {
  return enqueueAuto(state, { id, videoId: `v-${id}`, title: `Auto ${id}`, enqueuedAt: now });
}

const ids = (s: QueueState) => s.queue.map((e) => e.id);

describe('enqueueRequest', () => {
  it('starts immediately when idle, bumping the revision once and emitting play', () => {
    const r = req(emptyQueueState(), 'a', 100);
    expect(r.state.revision).toBe(1);
    expect(r.state.nowPlaying).toMatchObject({
      id: 'req:a',
      status: 'playing',
      startedAt: 100,
      source: 'request',
    });
    expect(r.effects).toEqual([{ type: 'play', entry: r.state.nowPlaying, revision: 1 }]);
    expect(r.entry).toBe(r.state.nowPlaying);
  });

  it('queues after the current track and earlier requests, ahead of auto entries', () => {
    let s = req(emptyQueueState(), 'a').state;
    s = auto(s, 'x1').state;
    s = auto(s, 'x2').state;
    s = req(s, 'b').state;
    s = req(s, 'c').state;
    expect(s.nowPlaying?.id).toBe('req:a');
    expect(ids(s)).toEqual(['req:b', 'req:c', 'x1', 'x2']);
    expect(s.revision).toBe(1);
  });

  it('is idempotent: the same key returns the existing entry without a duplicate', () => {
    const first = req(emptyQueueState(), 'a');
    const s1 = req(first.state, 'b').state;
    const again = req(s1, 'b');
    expect(again.duplicate).toBe(true);
    expect(again.state).toBe(s1);
    expect(again.entry.id).toBe('req:b');
    expect(again.effects).toEqual([]);
    // still recognised once the entry is playing or in history
    const played = transition(s1, { kind: 'ended', revision: s1.revision, now: 1 }).state;
    expect(req(played, 'b').duplicate).toBe(true);
    const done = transition(played, { kind: 'ended', revision: played.revision, now: 2 }).state;
    expect(req(done, 'b').duplicate).toBe(true);
    expect(req(done, 'b').entry.status).toBe('done');
  });

  it('keeps optional metadata and accepts an explicit id', () => {
    const r = enqueueRequest(emptyQueueState(), {
      videoId: 'v',
      title: 't',
      requester: null,
      idempotencyKey: 'k',
      now: 5,
      id: 'custom',
      channelTitle: 'Chan',
      thumbnail: 'th',
      durationSec: 200,
    });
    expect(r.entry).toMatchObject({
      id: 'custom',
      channelTitle: 'Chan',
      thumbnail: 'th',
      durationSec: 200,
    });
  });
});

describe('enqueueAuto', () => {
  it('starts when idle and appends otherwise; ignores a repeated id', () => {
    const r = auto(emptyQueueState(), 'x1', 7);
    expect(r.state.nowPlaying).toMatchObject({
      id: 'x1',
      source: 'auto',
      requester: null,
      startedAt: 7,
    });
    expect(r.effects[0]).toMatchObject({ type: 'play' });
    const r2 = auto(r.state, 'x2');
    expect(ids(r2.state)).toEqual(['x2']);
    expect(r2.effects).toEqual([]);
    expect(auto(r2.state, 'x2').state).toBe(r2.state);
    expect(auto(r2.state, 'x1').state).toBe(r2.state);
  });
});

describe('transition', () => {
  it('ended moves now playing to history as done and starts the next', () => {
    let s = req(emptyQueueState(), 'a').state;
    s = req(s, 'b').state;
    const r = transition(s, { kind: 'ended', revision: 1, now: 50 });
    expect(r.committed).toBe(true);
    expect(r.state.revision).toBe(2);
    expect(r.state.history).toEqual([
      expect.objectContaining({ id: 'req:a', status: 'done', endedAt: 50 }),
    ]);
    expect(r.state.nowPlaying).toMatchObject({ id: 'req:b', status: 'playing', startedAt: 50 });
    expect(r.effects).toEqual([{ type: 'play', entry: r.state.nowPlaying, revision: 2 }]);
  });

  it('error records failed with the reason; skipped records a player skip', () => {
    let s = req(emptyQueueState(), 'a').state;
    s = req(s, 'b').state;
    s = transition(s, { kind: 'error', revision: 1, failReason: 'yt-150', now: 1 }).state;
    s = transition(s, { kind: 'skipped', revision: 2, now: 2 }).state;
    expect(s.history).toEqual([
      expect.objectContaining({ id: 'req:a', status: 'failed', failReason: 'yt-150' }),
      expect.objectContaining({ id: 'req:b', status: 'skipped', skipReason: 'player' }),
    ]);
    const def = transition(req(emptyQueueState(), 'z').state, {
      kind: 'error',
      revision: 1,
      now: 0,
    });
    expect(def.state.history[0]?.failReason).toBe('error');
  });

  it('emits needFallback and goes idle when the queue is empty', () => {
    const s = req(emptyQueueState(), 'a').state;
    const r = transition(s, { kind: 'ended', revision: 1, now: 1 });
    expect(r.state.nowPlaying).toBeNull();
    expect(r.state.revision).toBe(2);
    expect(r.effects).toEqual([{ type: 'needFallback' }]);
  });

  it('ignores stale, future and idle reports, returning the same state object', () => {
    const s = req(emptyQueueState(), 'a').state;
    for (const revision of [0, 2, 99]) {
      const r = transition(s, { kind: 'ended', revision, now: 1 });
      expect(r).toEqual({ state: s, effects: [], committed: false });
      expect(r.state).toBe(s);
    }
    const idle = emptyQueueState();
    expect(transition(idle, { kind: 'ended', revision: 0, now: 1 }).committed).toBe(false);
  });
});

describe('owner operations', () => {
  it('ownerSkip commits regardless of player revisions', () => {
    let s = req(emptyQueueState(), 'a').state;
    s = req(s, 'b').state;
    const r = ownerSkip(s, 9);
    expect(r.committed).toBe(true);
    expect(r.state.history[0]).toMatchObject({
      id: 'req:a',
      status: 'skipped',
      skipReason: 'owner',
    });
    expect(r.state.nowPlaying?.id).toBe('req:b');
    expect(ownerSkip(emptyQueueState(), 0).committed).toBe(false);
  });

  it('reorder moves one entry and clamps the index', () => {
    let s = req(emptyQueueState(), 'a').state;
    for (const k of ['b', 'c', 'd']) s = req(s, k).state;
    expect(ids(reorder(s, 'req:d', 0).state)).toEqual(['req:d', 'req:b', 'req:c']);
    expect(ids(reorder(s, 'req:b', 99).state)).toEqual(['req:c', 'req:d', 'req:b']);
    expect(ids(reorder(s, 'req:c', -3).state)).toEqual(['req:c', 'req:b', 'req:d']);
    expect(reorder(s, 'missing', 0).state).toBe(s);
    expect(reorder(s, 'req:b', 0).state.revision).toBe(s.revision);
  });

  it('remove drops a queued entry into history as removed; removing now playing skips', () => {
    let s = req(emptyQueueState(), 'a').state;
    s = req(s, 'b').state;
    s = req(s, 'c').state;
    const r = remove(s, 'req:b', 3);
    expect(ids(r.state)).toEqual(['req:c']);
    expect(r.state.revision).toBe(s.revision);
    expect(r.state.history).toEqual([
      expect.objectContaining({
        id: 'req:b',
        status: 'skipped',
        skipReason: 'removed',
        endedAt: 3,
      }),
    ]);
    const r2 = remove(s, 'req:a', 4);
    expect(r2.state.nowPlaying?.id).toBe('req:b');
    expect(r2.state.revision).toBe(s.revision + 1);
    expect(remove(s, 'missing', 0).state).toBe(s);
  });
});

describe('restoreAfterRestart', () => {
  const playing = () =>
    enqueueRequest(req(emptyQueueState(), 'a').state, {
      videoId: 'vb',
      title: 'B',
      requester: null,
      idempotencyKey: 'b',
      now: 0,
    }).state;

  it('restarts once when well before the end, marking restarted and bumping the revision', () => {
    const s = playing();
    const r = restoreAfterRestart(s, { now: 1000, positionSec: 60, durationSec: 200 });
    expect(r.state.nowPlaying).toMatchObject({ id: 'req:a', restarted: true, startedAt: 1000 });
    expect(r.state.revision).toBe(s.revision + 1);
    expect(r.effects).toEqual([
      { type: 'play', entry: r.state.nowPlaying, revision: r.state.revision },
    ]);
    // a second restart never restarts again
    const r2 = restoreAfterRestart(r.state, { now: 2000, positionSec: 10, durationSec: 200 });
    expect(r2.state.nowPlaying?.id).toBe('req:b');
    expect(r2.state.history.at(-1)).toMatchObject({
      id: 'req:a',
      status: 'skipped',
      skipReason: 'restart',
    });
  });

  it('advances as done within 30 s of the end (boundary inclusive)', () => {
    const s = playing();
    const r = restoreAfterRestart(s, { now: 1, positionSec: 170, durationSec: 200 });
    expect(r.state.history.at(-1)).toMatchObject({ id: 'req:a', status: 'done' });
    expect(r.state.nowPlaying?.id).toBe('req:b');
    const r2 = restoreAfterRestart(s, { now: 1, positionSec: 169.9, durationSec: 200 });
    expect(r2.state.nowPlaying).toMatchObject({ id: 'req:a', restarted: true });
  });

  it("uses the entry's duration when none is passed, and restarts with an unknown duration", () => {
    const s = enqueueRequest(emptyQueueState(), {
      videoId: 'v',
      title: 't',
      requester: null,
      idempotencyKey: 'k',
      now: 0,
      durationSec: 100,
    }).state;
    expect(restoreAfterRestart(s, { now: 1, positionSec: 80 }).state.nowPlaying).toBeNull();
    expect(
      restoreAfterRestart(playing(), { now: 1, positionSec: 9999 }).state.nowPlaying,
    ).toMatchObject({
      restarted: true,
    });
  });

  it('with nothing playing starts the queue head or asks for a fallback', () => {
    expect(restoreAfterRestart(emptyQueueState(), { now: 0, positionSec: 0 }).effects).toEqual([
      { type: 'needFallback' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties

type Op =
  | { t: 'req'; key: number }
  | { t: 'auto' }
  | { t: 'report'; delta: number; kind: 'ended' | 'error' | 'skipped'; copies: number }
  | { t: 'skip' }
  | { t: 'remove'; pick: number }
  | { t: 'reorder'; pick: number; to: number }
  | { t: 'restore'; pos: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('req' as const), key: fc.integer({ min: 0, max: 30 }) }),
  fc.record({ t: fc.constant('auto' as const) }),
  fc.record({
    t: fc.constant('report' as const),
    delta: fc.integer({ min: -3, max: 1 }),
    kind: fc.constantFrom('ended' as const, 'error' as const, 'skipped' as const),
    copies: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({ t: fc.constant('skip' as const) }),
  fc.record({ t: fc.constant('remove' as const), pick: fc.nat() }),
  fc.record({
    t: fc.constant('reorder' as const),
    pick: fc.nat(),
    to: fc.integer({ min: -2, max: 40 }),
  }),
  fc.record({ t: fc.constant('restore' as const), pos: fc.integer({ min: 0, max: 300 }) }),
);

describe('queue machine properties', () => {
  it('duplicate, late and interleaved transitions never double-advance; revision +1 per commit', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        let s = emptyQueueState();
        let autoN = 0;
        let now = 0;
        for (const op of ops) {
          now += 1;
          const before = s;
          if (op.t === 'report') {
            // Several players report the same (possibly stale) revision, interleaved.
            const seen = s.revision + op.delta;
            let commits = 0;
            for (let i = 0; i < op.copies; i++) {
              const r = transition(s, { kind: op.kind, revision: seen, now });
              if (r.committed) commits++;
              s = r.state;
            }
            const shouldCommit = op.delta === 0 && before.nowPlaying !== null;
            expect(commits).toBe(shouldCommit ? 1 : 0);
            expect(s.revision).toBe(before.revision + commits);
            expect(s.history.length).toBe(before.history.length + commits);
            if (commits === 1) expect(s.history.at(-1)?.id).toBe(before.nowPlaying?.id);
          } else if (op.t === 'req') {
            s = req(s, String(op.key), now).state;
          } else if (op.t === 'auto') {
            s = auto(s, `auto${autoN++}`, now).state;
          } else if (op.t === 'skip') {
            const r = ownerSkip(s, now);
            s = r.state;
            expect(s.revision).toBe(before.revision + (r.committed ? 1 : 0));
          } else if (op.t === 'remove') {
            const target = s.queue[op.pick % Math.max(1, s.queue.length)];
            if (target) s = remove(s, target.id, now).state;
            expect(s.revision).toBe(before.revision);
          } else if (op.t === 'reorder') {
            const target = s.queue[op.pick % Math.max(1, s.queue.length)];
            if (target) s = reorder(s, target.id, op.to).state;
            expect(s.revision).toBe(before.revision);
          } else {
            s = restoreAfterRestart(s, { now, positionSec: op.pos, durationSec: 200 }).state;
            expect(s.revision).toBe(before.revision + 1);
          }
          // nowPlaying changes iff the revision changes
          expect(s.revision >= before.revision).toBe(true);
          if (s.revision === before.revision) expect(s.nowPlaying?.id).toBe(before.nowPlaying?.id);
          // invariants: every entry lives in exactly one place
          const all = [
            ...(s.nowPlaying ? [s.nowPlaying.id] : []),
            ...s.queue.map((e) => e.id),
            ...s.history.map((e) => e.id),
          ];
          expect(new Set(all).size).toBe(all.length);
          expect(s.queue.every((e) => e.status === 'queued')).toBe(true);
          if (s.nowPlaying) expect(s.nowPlaying.status).toBe('playing');
        }
      }),
    );
  });

  it('idempotent enqueue never duplicates, whatever the replay order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 60 }),
        fc.boolean(),
        (keys, drain) => {
          let s = emptyQueueState();
          for (const k of keys) {
            s = req(s, String(k)).state;
            if (drain) s = transition(s, { kind: 'ended', revision: s.revision, now: 0 }).state;
          }
          const all = [...(s.nowPlaying ? [s.nowPlaying] : []), ...s.queue, ...s.history];
          expect(all.length).toBe(new Set(keys).size);
          expect(new Set(all.map((e) => e.idempotencyKey)).size).toBe(all.length);
        },
      ),
    );
  });

  it('FIFO order of requests is preserved under remove, and reorder moves only its target', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 25 }),
        fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.integer({ min: 0, max: 30 })), {
          maxLength: 30,
        }),
        (n, ops) => {
          let s = auto(emptyQueueState(), 'playing').state;
          for (let i = 0; i < n; i++) {
            s = req(s, String(i)).state;
            if (i % 3 === 0) s = auto(s, `a${i}`).state;
          }
          const expected = Array.from({ length: n }, (_, i) => `req:${i}`);
          // requests come first, in arrival order
          expect(ids(s).slice(0, n)).toEqual(expected);
          for (const [isRemove, pick, to] of ops) {
            if (s.queue.length === 0) break;
            const target = s.queue[pick % s.queue.length] as { id: string };
            const before = ids(s);
            if (isRemove) {
              s = remove(s, target.id, 0).state;
              expect(ids(s)).toEqual(before.filter((id) => id !== target.id));
            } else {
              s = reorder(s, target.id, to).state;
              const others = ids(s).filter((id) => id !== target.id);
              expect(others).toEqual(before.filter((id) => id !== target.id));
              expect(ids(s)).toContain(target.id);
            }
          }
        },
      ),
    );
  });
});
