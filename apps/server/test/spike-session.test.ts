import { SPIKE_MATRIX } from '@room-jukebox/shared';
import { describe, expect, it } from 'vitest';
import { SpikeSession } from '../src/spike/session.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SpikeSession', () => {
  it('pause/resume/seek move the clock fields without bumping the revision', () => {
    const c = clock();
    const s = new SpikeSession({ now: c.now });
    const rev = s.play('abc').revision;
    c.advance(10_000);
    s.pause();
    c.advance(5_000);
    let np = s.resume().nowPlaying!;
    expect(np.accumulatedPauseMs).toBe(5_000);
    expect(np.pausedAt).toBeNull();
    np = s.seek(42).nowPlaying!;
    expect((c.now() - np.startedAt - np.accumulatedPauseMs) / 1000).toBe(42);
    expect(s.revision).toBe(rev);
  });

  it('ended advances to the next matrix entry and wraps around', () => {
    const s = new SpikeSession({ now: clock().now });
    const last = SPIKE_MATRIX[SPIKE_MATRIX.length - 1]!;
    const rev = s.play(last.videoId).revision;
    s.hello('p1', 'tv', 'http://127.0.0.1:1');
    expect(s.event('p1', 'ended', rev).committed).toBe(true);
    expect(s.snapshot().nowPlaying?.videoId).toBe(SPIKE_MATRIX[0]!.videoId);
  });

  it('marks a player Delayed after 3 reports over 3 s and Online again within 1.5 s', () => {
    const c = clock();
    const s = new SpikeSession({ now: c.now });
    const rev = s.play('abc').revision;
    s.hello('p1', 'tv', 'o');
    c.advance(20_000); // expected = 20 s
    s.position('p1', 15, 1, rev);
    s.position('p1', 15, 1, rev);
    expect(s.player('p1')?.status).toBe('online');
    s.position('p1', 15, 2, rev);
    expect(s.player('p1')?.status).toBe('delayed');
    expect(s.player('p1')?.drift).toBeCloseTo(-5);
    s.position('p1', 18, 1, rev); // 2 s off: still delayed (hysteresis)
    expect(s.player('p1')?.status).toBe('delayed');
    s.position('p1', 19, 1, rev);
    expect(s.player('p1')?.status).toBe('online');
  });

  it('ignores drift for an old revision or an unstarted player', () => {
    const c = clock();
    const s = new SpikeSession({ now: c.now });
    const rev = s.play('abc').revision;
    s.hello('p1', 'tv', 'o');
    c.advance(20_000);
    for (let i = 0; i < 5; i++) s.position('p1', 0, -1, rev);
    for (let i = 0; i < 5; i++) s.position('p1', 0, 1, rev - 1);
    expect(s.player('p1')).toMatchObject({ status: 'online', drift: null });
  });

  it('autoplayBlocked marks Blocked until the player reports playing', () => {
    const s = new SpikeSession({ now: clock().now });
    const rev = s.play('abc').revision;
    s.hello('p1', 'tv', 'o');
    s.event('p1', 'autoplayBlocked', rev);
    s.position('p1', 0, 5, rev);
    expect(s.player('p1')?.status).toBe('blocked');
    s.event('p1', 'playing', rev);
    expect(s.player('p1')).toMatchObject({ status: 'online', playingRevision: rev });
  });

  it('players silent for more than 10 s become Reconnecting', () => {
    const c = clock();
    const s = new SpikeSession({ now: c.now });
    s.hello('p1', 'tv', 'o');
    c.advance(10_000);
    expect(s.sweep()).toBe(false);
    c.advance(1);
    expect(s.sweep()).toBe(true);
    expect(s.player('p1')?.status).toBe('reconnecting');
    s.touch('p1');
    expect(s.player('p1')?.status).toBe('online');
    c.advance(9_000);
    s.touch('p1');
    c.advance(9_000);
    expect(s.sweep()).toBe(false);
  });

  it('a late error is attributed to the video it was reported for and does not advance', () => {
    const s = new SpikeSession({ now: clock().now });
    s.hello('p1', 'tv', 'o');
    const r1 = s.play('first').revision;
    s.play('second');
    const result = s.event('p1', 'error', r1, 150);
    expect(result.committed).toBe(false);
    expect(result.error).toMatchObject({ videoId: 'first', code: 150 });
    expect(s.snapshot().nowPlaying?.videoId).toBe('second');
  });

  it('with autoAdvance off, ended and error are recorded but never advance', () => {
    const s = new SpikeSession({ now: clock().now });
    s.hello('p1', 'tv', 'o');
    const rev = s.play('abc').revision;
    s.setAutoAdvance(false);
    expect(s.event('p1', 'error', rev, 150)).toMatchObject({
      committed: false,
      error: { code: 150 },
    });
    expect(s.event('p1', 'ended', rev).committed).toBe(false);
    expect(s.revision).toBe(rev);
    s.setAutoAdvance(true);
    expect(s.event('p1', 'ended', rev).committed).toBe(true);
  });

  it('stops advancing on errors after 5 consecutive failures until something plays', () => {
    const s = new SpikeSession({ now: clock().now });
    s.hello('p1', 'tv', 'o');
    s.play('abc');
    for (let i = 0; i < 5; i++)
      expect(s.event('p1', 'error', s.revision, 150).committed).toBe(true);
    const stuck = s.revision;
    expect(s.event('p1', 'error', stuck, 150).committed).toBe(false);
    expect(s.snapshot().errorStreak).toBe(5);
    s.event('p1', 'playing', stuck);
    expect(s.snapshot().errorStreak).toBe(0);
    expect(s.event('p1', 'error', stuck, 150).committed).toBe(true);
  });
});
