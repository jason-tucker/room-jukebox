import { describe, expect, it } from 'vitest';
import { HeartbeatWatch, listenWithRetry, relaunchDecision } from '../src/robustness';

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => (t += ms),
  };
}
const inUse = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

describe('listenWithRetry', () => {
  it('retries every 2 s while the port is taken and succeeds once it frees up', async () => {
    const c = clock();
    let calls = 0;
    const retries: number[] = [];
    await listenWithRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw inUse();
      },
      { intervalMs: 2000, timeoutMs: 30_000, ...c, onRetry: (n) => retries.push(n) },
    );
    expect(calls).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
    expect(c.now()).toBe(6000);
  });

  it('gives up after 30 s with the EADDRINUSE error', async () => {
    const c = clock();
    let calls = 0;
    const p = listenWithRetry(
      async () => {
        calls += 1;
        throw inUse();
      },
      { intervalMs: 2000, timeoutMs: 30_000, ...c },
    );
    await expect(p).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(calls).toBe(16);
    expect(c.now()).toBe(30_000);
  });

  it('throws other errors at once', async () => {
    const c = clock();
    let calls = 0;
    const p = listenWithRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      { intervalMs: 2000, timeoutMs: 30_000, ...c },
    );
    await expect(p).rejects.toThrow('EACCES');
    expect(calls).toBe(1);
  });
});

describe('relaunch breaker', () => {
  const MIN = 60_000;
  it('allows 3 relaunches in 5 min, then stops', () => {
    let history: number[] = [];
    const results: boolean[] = [];
    for (const t of [0, MIN, 2 * MIN, 3 * MIN]) {
      const d = relaunchDecision(history, t);
      results.push(d.relaunch);
      history = d.history;
    }
    expect(results).toEqual([true, true, true, false]);
    expect(history).toEqual([0, MIN, 2 * MIN]);
  });

  it('forgets relaunches older than 5 min', () => {
    const d = relaunchDecision([0, 1000, 2000], 5 * MIN + 1000);
    expect(d.relaunch).toBe(true);
    expect(d.history).toEqual([2000, 5 * MIN + 1000]);
  });

  it('drops timestamps from the future (clock moved back)', () => {
    expect(relaunchDecision([10 * MIN, 11 * MIN, 12 * MIN], MIN).relaunch).toBe(true);
  });
});

describe('heartbeat watch', () => {
  it('goes stale after 30 s without a beat', () => {
    const c = clock(1000);
    const hb = new HeartbeatWatch(30_000, c.now);
    c.advance(29_999);
    expect(hb.stale()).toBe(false);
    c.advance(1);
    expect(hb.stale()).toBe(true);
    hb.beat();
    expect(hb.stale()).toBe(false);
  });
});
