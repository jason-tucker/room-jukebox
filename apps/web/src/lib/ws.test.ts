import type { GuestState } from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../test/fakeWs.ts';
import { guestState, playerState } from '../test/fixtures.ts';
import { backoffDelay, estimateOffset, SessionClient } from './ws.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SessionClient', () => {
  beforeEach(() => FakeWebSocket.reset());
  afterEach(() => vi.useRealTimers());

  it('connects with the role and extra query on the page origin', async () => {
    const c = new SessionClient({
      role: 'player',
      query: { player: 'tv1', token: 'tok' },
      origin: 'http://hub.local:8080',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    c.start();
    await flush();
    expect(FakeWebSocket.last().url).toBe(
      'ws://hub.local:8080/ws?role=player&player=tv1&token=tok',
    );
    c.stop();
  });

  it('resyncs over HTTP when a heartbeat shows a missed changeSeq', async () => {
    let next: GuestState = guestState({ changeSeq: 5 });
    const snapshot = vi.fn(() => Promise.resolve(next));
    const c = new SessionClient({
      role: 'guest',
      origin: 'http://hub',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      fetchSnapshot: snapshot,
    });
    c.start();
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(1); // first paint
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: 'state', state: guestState({ changeSeq: 6, roomName: 'From WS' }) });
    expect(c.state?.roomName).toBe('From WS');

    ws.receive({ type: 'heartbeat', serverTime: Date.now(), changeSeq: 6, revision: 1 });
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(c.resyncs).toBe(0);

    next = guestState({ changeSeq: 8, roomName: 'From HTTP' });
    ws.receive({ type: 'heartbeat', serverTime: Date.now(), changeSeq: 8, revision: 1 });
    await flush();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(c.resyncs).toBe(1);
    expect(c.state?.changeSeq).toBe(8);
    expect(c.state?.roomName).toBe('From HTTP');

    // An older state arriving late never overwrites a newer one.
    ws.receive({ type: 'state', state: guestState({ changeSeq: 7, roomName: 'Stale' }) });
    expect(c.state?.roomName).toBe('From HTTP');
    c.stop();
  });

  it('takes a state message after a gap as-is (it is a full projection)', async () => {
    const snapshot = vi.fn(() => Promise.resolve(null));
    const c = new SessionClient({
      role: 'guest',
      origin: 'http://hub',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      fetchSnapshot: snapshot,
    });
    c.start();
    await flush();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: 'state', state: guestState({ changeSeq: 1 }) });
    ws.receive({ type: 'state', state: guestState({ changeSeq: 9, roomName: 'Jumped' }) });
    expect(c.state?.roomName).toBe('Jumped');
    expect(c.resyncs).toBe(0);
    c.stop();
  });

  it('the player resyncs by reconnecting (no HTTP snapshot route in M1)', async () => {
    vi.useFakeTimers();
    const c = new SessionClient({
      role: 'player',
      origin: 'http://hub',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.last();
    ws.open();
    ws.receive({ type: 'state', state: playerState({ changeSeq: 3 }) });
    ws.receive({ type: 'heartbeat', serverTime: Date.now(), changeSeq: 4, revision: 2 });
    expect(ws.readyState).toBe(3);
    expect(c.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    c.stop();
  });

  it('forwards toasts and answers pongs into the clock offset', async () => {
    const c = new SessionClient({
      role: 'guest',
      origin: 'http://hub',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      fetchSnapshot: null,
    });
    const toasts: string[] = [];
    c.onToast((t) => toasts.push(t.message));
    c.start();
    await flush();
    const ws = FakeWebSocket.last();
    ws.open();
    expect(ws.sent[0]).toMatchObject({ type: 'ping' });
    ws.receive({ type: 'toast', level: 'info', message: 'Added', ttlMs: 3000 });
    expect(toasts).toEqual(['Added']);
    const t0 = Date.now();
    ws.receive({ type: 'pong', t0, serverTime: t0 + 5000 });
    expect(Math.abs(c.offsetMs() - 5000)).toBeLessThan(100);
    c.stop();
  });
});

describe('helpers', () => {
  it('backs off 1 s → 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
  it('uses the median offset of the last five samples', () => {
    const s = (off: number) => ({ t0: 0, t1: off, t2: 0 });
    expect(estimateOffset([])).toBe(0);
    expect(estimateOffset([s(900), s(10), s(20), s(30), s(40), s(50)])).toBe(30);
  });
});
