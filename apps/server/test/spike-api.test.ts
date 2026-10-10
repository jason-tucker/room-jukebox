import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from '@fastify/websocket';
import { SPIKE_MATRIX, type SpikeServerMessage, type SpikeState } from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

type App = Awaited<ReturnType<typeof buildApp>>;

/** A WS test client that buffers every server message from the moment the socket exists. */
async function connect(app: App, origin = 'http://127.0.0.1:5173') {
  const messages: SpikeServerMessage[] = [];
  const waiters: Array<() => void> = [];
  const ws: WebSocket = await app.injectWS(
    '/ws',
    { headers: { origin } },
    {
      onInit(socket) {
        socket.on('message', (raw: Buffer) => {
          messages.push(JSON.parse(String(raw)) as SpikeServerMessage);
          for (const w of waiters.splice(0)) w();
        });
      },
    },
  );
  const next = async <T extends SpikeServerMessage['type']>(
    type: T,
    predicate: (m: Extract<SpikeServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<SpikeServerMessage, { type: T }>> => {
    for (;;) {
      const i = messages.findIndex(
        (m) => m.type === type && predicate(m as Extract<SpikeServerMessage, { type: T }>),
      );
      if (i >= 0)
        return messages.splice(0, i + 1).pop() as Extract<SpikeServerMessage, { type: T }>;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  const sendJson = (msg: unknown) => ws.send(JSON.stringify(msg));
  return { ws, messages, next, send: sendJson };
}

describe('spike API + WebSocket', () => {
  let app: App;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'spike-'));
    app = await buildApp({ webRoot: '/nonexistent', spikeDataDir: dataDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (url: string, payload: unknown = {}) => {
    const res = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: res.statusCode, body: res.json() as SpikeState };
  };

  it('sends state on connect and broadcasts state changes to every client', async () => {
    const a = await connect(app);
    const b = await connect(app, 'http://localhost:5173');
    expect((await a.next('state')).state.revision).toBe(0);
    await b.next('state');

    const { body } = await post('/api/spike/play', { videoId: 'dQw4w9WgXcQ' });
    for (const c of [a, b]) {
      const msg = await c.next('state', (m) => m.state.revision === body.revision);
      expect(msg.state.nowPlaying?.videoId).toBe('dQw4w9WgXcQ');
      expect(msg.state.nowPlaying?.title).toBe(SPIKE_MATRIX[0]!.title);
    }

    a.send({ type: 'hello', playerId: 'pa', name: 'Living room' });
    const withPlayer = await b.next('state', (m) => m.state.players.length === 1);
    expect(withPlayer.state.players[0]).toMatchObject({
      id: 'pa',
      name: 'Living room',
      origin: 'http://127.0.0.1:5173',
      status: 'online',
    });

    await post('/api/spike/pause');
    const paused = await b.next('state', (m) => m.state.nowPlaying?.pausedAt !== null);
    expect(paused.state.revision).toBe(body.revision);
    a.ws.terminate();
    b.ws.terminate();
  });

  it('answers ping with pong carrying t0 and serverTime', async () => {
    const c = await connect(app);
    const before = Date.now();
    c.send({ type: 'ping', t0: 42 });
    const pong = await c.next('pong');
    expect(pong.t0).toBe(42);
    expect(pong.serverTime).toBeGreaterThanOrEqual(before);
    c.ws.terminate();
  });

  it('applies duplicate ended events from two players exactly once (single transition rule)', async () => {
    const a = await connect(app);
    const b = await connect(app, 'http://localhost:5173');
    a.send({ type: 'hello', playerId: 'pa', name: 'A' });
    b.send({ type: 'hello', playerId: 'pb', name: 'B' });
    const { body } = await post('/api/spike/play', { videoId: SPIKE_MATRIX[3]!.videoId });
    const rev = body.revision;

    for (let i = 0; i < 3; i++) {
      a.send({ type: 'event', playerId: 'pa', kind: 'ended', revision: rev });
      b.send({ type: 'event', playerId: 'pb', kind: 'ended', revision: rev });
    }
    const advanced = await a.next('state', (m) => m.state.revision === rev + 1);
    expect(advanced.state.nowPlaying?.videoId).toBe(SPIKE_MATRIX[4]!.videoId);

    // Round-trip a ping on each socket so every earlier event has been processed.
    a.send({ type: 'ping', t0: 1 });
    b.send({ type: 'ping', t0: 2 });
    await a.next('pong');
    await b.next('pong');
    const state = (
      await app.inject({ method: 'GET', url: '/api/spike/state' })
    ).json() as SpikeState;
    expect(state.revision).toBe(rev + 1);
    expect(state.nowPlaying?.videoId).toBe(SPIKE_MATRIX[4]!.videoId);
    a.ws.terminate();
    b.ws.terminate();
  });

  it('an error event advances once and is recorded in the results', async () => {
    const a = await connect(app);
    a.send({ type: 'hello', playerId: 'pa', name: 'A' });
    const { body } = await post('/api/spike/play', { videoId: 'dQw4w9WgXcZ' });
    a.send({ type: 'event', playerId: 'pa', kind: 'error', code: 100, revision: body.revision });
    a.send({ type: 'event', playerId: 'pa', kind: 'error', code: 100, revision: body.revision });
    const st = await a.next('state', (m) => m.state.revision === body.revision + 1);
    expect(st.state.players[0]?.lastError).toEqual({ code: 100, revision: body.revision });

    let results: unknown[] = [];
    for (let i = 0; i < 50 && results.length < 2; i++) {
      results = (await app.inject({ method: 'GET', url: '/api/spike/results' })).json();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      playerId: 'pa',
      videoId: 'dQw4w9WgXcZ',
      event: 'error',
      code: 100,
    });
    const after = (
      await app.inject({ method: 'GET', url: '/api/spike/state' })
    ).json() as SpikeState;
    expect(after.revision).toBe(body.revision + 1);
    a.ws.terminate();
  });

  it('round-trips reports through results and clears them', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/spike/results' });
    expect(empty.json()).toEqual([]);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/spike/report',
      payload: { playerId: 'pa', videoId: 'dQw4w9WgXcQ', event: 'matrix', note: 'reached playing' },
    });
    expect(ok.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/api/spike/report',
      payload: { playerId: 'pb', videoId: 'x', event: 'matrix', code: 150 },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/spike/report',
      payload: { videoId: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const listed = (await app.inject({ method: 'GET', url: '/api/spike/results' })).json();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ playerId: 'pa', event: 'matrix', note: 'reached playing' });
    expect(listed[1]).toMatchObject({ playerId: 'pb', code: 150 });
    expect(typeof listed[0].ts).toBe('number');

    expect((await app.inject({ method: 'DELETE', url: '/api/spike/results' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/api/spike/results' })).json()).toEqual([]);
  });

  it('validates command bodies and serves the 20-video matrix', async () => {
    expect((await post('/api/spike/play', {})).status).toBe(400);
    expect((await post('/api/spike/seek', { position: -1 })).status).toBe(400);
    const matrix = await app.inject({ method: 'GET', url: '/api/spike/matrix' });
    expect(matrix.json()).toHaveLength(20);
  });

  it('allows DELETE from a loopback origin (cross-origin Player-mode page)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/spike/results',
      headers: {
        origin: 'http://127.0.0.1:49152',
        'access-control-request-method': 'DELETE',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:49152');
    expect(String(res.headers['access-control-allow-methods'])).toContain('DELETE');
  });
});

describe('spikeAutoplay option', () => {
  it('starts the first matrix video when enabled', async () => {
    const app = await buildApp({ spikeAutoplay: true, spikeDataDir: mkdtempSync(join(tmpdir(), 'spike-')) });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/spike/state' });
      expect(res.statusCode).toBe(200);
      expect(res.json().nowPlaying).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
