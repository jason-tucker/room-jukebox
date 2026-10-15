import type { AdminState, GuestState, PlayerState } from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWs, flush, Guest, makeHub, setup, vid } from './helpers.ts';
import type { TestHub, WsClient } from './helpers.ts';

let hub: TestHub;
let creds: Awaited<ReturnType<typeof setup>>;

const admin = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) =>
  hub.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${creds.token}` },
    ...(payload ? { payload } : {}),
  });

const adminState = async () => (await admin('GET', '/api/admin/session')).json() as AdminState;

async function player(): Promise<WsClient> {
  const c = await connectWs(
    hub.app,
    `/ws?role=player&player=${creds.playerId}&token=${creds.playerToken}`,
  );
  await c.next('state');
  return c;
}

const lastPlayerState = async (c: WsClient) => {
  await flush(c);
  const s = hub.app.jukebox.session;
  return { revision: s.revision, np: s.state.nowPlaying, queue: s.state.queue };
};

/** The player socket's `state` for the session's current `changeSeq`. */
const lastPlayerStateMsg = async (c: WsClient): Promise<PlayerState> => {
  const seq = hub.app.jukebox.session.changeSeq;
  return (await c.next('state', (m) => m.state.changeSeq === seq)).state as PlayerState;
};

beforeEach(async () => {
  hub = await makeHub();
  for (let i = 1; i <= 9; i++) hub.yt.add({ id: vid(i), title: `Song ${i}` });
  creds = await setup(hub.app);
});
afterEach(async () => hub.close());

describe('requests', () => {
  it('two simultaneous requests from two guests → exactly one entry each', async () => {
    const a = new Guest(hub.app, '192.168.1.51');
    const b = new Guest(hub.app, '192.168.1.52');
    await a.hello('Ann');
    await b.hello('Bob');
    const [ra, rb] = await Promise.all([a.request(vid(1), 'ka'), b.request(vid(2), 'kb')]);
    expect(ra.statusCode).toBe(201);
    expect(rb.statusCode).toBe(201);
    const s = hub.app.jukebox.session.state;
    const all = [s.nowPlaying, ...s.queue].filter((e) => e !== null);
    expect(all.map((e) => e.requester?.name).sort()).toEqual(['Ann', 'Bob']);
  });

  it('a retried command (same idempotency key, concurrently) creates one entry', async () => {
    const g = new Guest(hub.app);
    await g.hello('Cy');
    const [r1, r2, r3] = await Promise.all([
      g.request(vid(1), 'same'),
      g.request(vid(1), 'same'),
      g.request(vid(1), 'same'),
    ]);
    const bodies = [r1, r2, r3].map((r) => r.json());
    expect(bodies.filter((b) => b.duplicate === false)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.entry.id)).size).toBe(1);
    const s = hub.app.jukebox.session.state;
    expect([s.nowPlaying, ...s.queue].filter((e) => e !== null)).toHaveLength(1);
    expect(bodies[0].entry.mine).toBe(true);
  });

  it('applies limits: cooldown then too-many-pending, with retryAfterSec', async () => {
    const g = new Guest(hub.app);
    await g.hello();
    expect((await g.request(vid(1))).statusCode).toBe(201);
    const cool = await g.request(vid(2));
    expect(cool.statusCode).toBe(429);
    expect(cool.json().error).toMatchObject({ code: 'cooldown', retryAfterSec: 5 });
    for (let i = 2; i <= 6; i++) {
      hub.clock.advance(6000);
      expect((await g.request(vid(i))).statusCode).toBe(201);
    }
    hub.clock.advance(6000);
    const many = await g.request(vid(7));
    expect(many.statusCode).toBe(429);
    expect(many.json().error.code).toBe('too-many-pending');
  });

  it('owner requests skip limits and show as Owner', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await admin('POST', '/api/admin/requests', {
        videoId: vid(i),
        idempotencyKey: `o${i}`,
      });
      expect(r.statusCode).toBe(201);
    }
    const st = await adminState();
    expect(st.playback.nowPlaying?.requesterName).toBe('Owner');
    expect(st.queue.map((e) => e.requesterGuestId)).toEqual([null, null]);
  });

  it('sends a toast to the requesting guest only', async () => {
    const g = new Guest(hub.app);
    await g.hello('Di');
    const ws = await connectWs(hub.app, '/ws?role=guest', {
      ip: g.ip,
      headers: { cookie: g.cookie },
    });
    const other = await connectWs(hub.app, '/ws?role=guest');
    await ws.next('state');
    await g.request(vid(3));
    const toast = await ws.next('toast');
    expect(toast).toMatchObject({ level: 'info', message: 'Added “Song 3” to the queue.' });
    const st = (await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState;
    expect(st.playback.nowPlaying?.mine).toBe(true);
    await flush(other);
    expect(other.messages.some((m) => m.type === 'toast')).toBe(false);
    ws.ws.terminate();
    other.ws.terminate();
  });
});

describe('player transitions', () => {
  it('duplicate ended advances exactly once', async () => {
    const p = await player();
    for (let i = 1; i <= 3; i++) {
      await admin('POST', '/api/admin/requests', { videoId: vid(i), idempotencyKey: `o${i}` });
    }
    const rev = hub.app.jukebox.session.revision;
    for (let i = 0; i < 4; i++) p.send({ type: 'event', kind: 'ended', revision: rev });
    const after = await lastPlayerState(p);
    expect(after.revision).toBe(rev + 1);
    expect(after.np?.videoId).toBe(vid(2));
    // a late report for the old revision changes nothing
    p.send({ type: 'event', kind: 'error', code: 150, revision: rev });
    expect((await lastPlayerState(p)).np?.videoId).toBe(vid(2));
    p.ws.terminate();
  });

  it('a play-time error toasts the requester only', async () => {
    const a = new Guest(hub.app, '192.168.1.51');
    const b = new Guest(hub.app, '192.168.1.52');
    await a.hello('Ann');
    await b.hello('Bob');
    const wa = await connectWs(hub.app, '/ws?role=guest', {
      ip: a.ip,
      headers: { cookie: a.cookie },
    });
    const wb = await connectWs(hub.app, '/ws?role=guest', {
      ip: b.ip,
      headers: { cookie: b.cookie },
    });
    const p = await player();
    expect((await a.request(vid(1), 'ka')).statusCode).toBe(201);
    const rev = hub.app.jukebox.session.revision;
    p.send({ type: 'event', kind: 'error', code: 150, revision: rev });
    const toast = await wa.next('toast', (m) => m.level === 'warn');
    expect(toast.message).toMatch(/^Couldn't play Song 1: .+\. It was skipped\.$/);
    expect(toast.ttlMs).toBe(8000);
    await flush(wb);
    expect(wb.messages.some((m) => m.type === 'toast' && m.level === 'warn')).toBe(false);
    for (const c of [p, wa, wb]) c.ws.terminate();
  });

  it('requests beat fallback after the current track', async () => {
    hub.yt.add({ id: vid(20), title: 'Auto A' }, { id: vid(21), title: 'Auto B' });
    hub.yt.playlists.set('PLfallback0001', { items: [{ id: vid(20) }, { id: vid(21) }] });
    const noKey = await admin('POST', '/api/admin/playlists', { url: 'PLfallback0001' });
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json().error.code).toBe('no-api-key');
    // no API key yet → 422 no-api-key; add one and import
    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaTESTKEY0001' });
    const pl = await admin('POST', '/api/admin/playlists', {
      url: 'https://www.youtube.com/playlist?list=PLfallback0001',
    });
    expect(pl.json()).toMatchObject({ playlistId: 'PLfallback0001', videoCount: 2 });

    const p = await player();
    let s = await lastPlayerState(p);
    expect(s.np?.source).toBe('auto');
    const g = new Guest(hub.app);
    await g.request(vid(5));
    s = await lastPlayerState(p);
    expect(s.np?.source).toBe('auto');
    expect(s.queue.map((e) => e.videoId)).toEqual([vid(5)]);
    p.send({ type: 'event', kind: 'ended', revision: s.revision });
    s = await lastPlayerState(p);
    expect(s.np).toMatchObject({ videoId: vid(5), source: 'request' });
    p.send({ type: 'event', kind: 'ended', revision: s.revision });
    s = await lastPlayerState(p);
    expect(s.np?.source).toBe('auto');
    p.ws.terminate();
  });

  it('a tiny fallback pool does not stall', async () => {
    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaTESTKEY0001' });
    hub.yt.add({ id: vid(30), title: 'Only one' });
    hub.yt.playlists.set('PLtinytiny001', { items: [{ id: vid(30) }] });
    await admin('POST', '/api/admin/playlists', { url: 'PLtinytiny001' });
    const p = await player();
    for (let i = 0; i < 6; i++) {
      const s = await lastPlayerState(p);
      expect(s.np?.videoId).toBe(vid(30));
      p.send({ type: 'event', kind: 'ended', revision: s.revision });
    }
    const st = await adminState();
    expect(st.playback.state).toBe('playing');
    expect(st.fallback.poolSize).toBe(1);
    p.ws.terminate();
  });

  it('stops after 5 consecutive failures, then Start Music (play) resumes', async () => {
    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaTESTKEY0001' });
    hub.yt.add({ id: vid(40), title: 'X' }, { id: vid(41), title: 'Y' });
    hub.yt.playlists.set('PLbrokenbroken', { items: [{ id: vid(40) }, { id: vid(41) }] });
    await admin('POST', '/api/admin/playlists', { url: 'PLbrokenbroken' });
    const p = await player();
    for (let i = 0; i < 5; i++) {
      const s = await lastPlayerState(p);
      expect(s.np).not.toBeNull();
      p.send({ type: 'event', kind: 'error', code: 150, revision: s.revision });
    }
    await flush(p);
    const st = await adminState();
    expect(st.playback.state).toBe('idle');
    expect(st.fallback.consecutiveFailures).toBe(5);
    expect(st.lastErrors).toHaveLength(5);
    expect(st.lastErrors[0]).toMatchObject({ code: '150' });
    const ps: PlayerState = hub.app.jukebox.session.toPlayerState(creds.playerId);
    expect(ps.lastError).toMatchObject({ code: 'stopped' });
    expect(ps.lastError?.message).toMatch(/Start Music/);
    await admin('POST', '/api/admin/transport', { action: 'play', idempotencyKey: 'start' });
    expect((await lastPlayerState(p)).np).not.toBeNull();
    p.ws.terminate();
  });

  it('pause/play move the clock without a revision bump; skip is idempotent', async () => {
    for (let i = 1; i <= 3; i++) {
      await admin('POST', '/api/admin/requests', { videoId: vid(i), idempotencyKey: `o${i}` });
    }
    const rev = hub.app.jukebox.session.revision;
    await admin('POST', '/api/admin/transport', { action: 'pause', idempotencyKey: 'p1' });
    let st = await adminState();
    expect(st.playback.state).toBe('paused');
    hub.clock.advance(5000);
    await admin('POST', '/api/admin/transport', { action: 'play', idempotencyKey: 'p2' });
    st = await adminState();
    expect(st.playback.state).toBe('playing');
    expect(st.playback.nowPlaying?.accumulatedPauseMs).toBe(5000);
    expect(st.revision).toBe(rev);
    await admin('POST', '/api/admin/transport', { action: 'skip', idempotencyKey: 's1' });
    await admin('POST', '/api/admin/transport', { action: 'skip', idempotencyKey: 's1' });
    st = await adminState();
    expect(st.playback.nowPlaying?.videoId).toBe(vid(2));
    expect(st.recentHistory[0]).toMatchObject({ videoId: vid(1), status: 'skipped' });
  });

  it('reorder and remove', async () => {
    for (let i = 1; i <= 4; i++) {
      await admin('POST', '/api/admin/requests', { videoId: vid(i), idempotencyKey: `o${i}` });
    }
    let st = await adminState();
    const ids = st.queue.map((e) => e.id);
    await admin('POST', '/api/admin/queue/reorder', {
      id: ids[2],
      toIndex: 0,
      idempotencyKey: 'r',
    });
    st = await adminState();
    expect(st.queue.map((e) => e.videoId)).toEqual([vid(4), vid(2), vid(3)]);
    expect((await admin('DELETE', `/api/admin/queue/${ids[0]}`)).statusCode).toBe(200);
    expect((await admin('DELETE', `/api/admin/queue/nope`)).statusCode).toBe(404);
    st = await adminState();
    expect(st.queue.map((e) => e.videoId)).toEqual([vid(4), vid(3)]);
  });

  it('player status: delayed on drift, blocked on autoplayBlocked, reconnecting on close', async () => {
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    const p = await player();
    const rev = hub.app.jukebox.session.revision;
    for (let i = 0; i < 3; i++)
      p.send({ type: 'position', position: 100, playerState: 1, revision: rev });
    await flush(p);
    expect(hub.app.jukebox.session.players()[0]?.status).toBe('delayed');
    p.send({ type: 'event', kind: 'autoplayBlocked', revision: rev });
    await flush(p);
    let st = await adminState();
    expect(st.playback.state).toBe('blocked');
    p.send({ type: 'event', kind: 'playing', revision: rev });
    await flush(p);
    st = await adminState();
    expect(st.players[0]).toMatchObject({ status: 'online', role: 'leader' });
    p.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.app.jukebox.session.players()[0]?.status).toBe('reconnecting');
    hub.clock.advance(61_000);
    hub.app.jukebox.session.sweep();
    expect(hub.app.jukebox.session.players()[0]?.status).toBe('offline');
  });

  it('closes sockets that send bad messages with bye', async () => {
    const g = await connectWs(hub.app, '/ws?role=guest');
    await g.next('state');
    g.send({ type: 'position', position: 1, playerState: 1, revision: 0 });
    expect(await g.next('bye')).toEqual({ type: 'bye', reason: 'bad-message' });
    const h = await connectWs(hub.app, '/ws?role=guest');
    h.ws.send('not json');
    expect((await h.next('bye')).reason).toBe('bad-message');
  });

  it('sends heartbeats with changeSeq and revision', async () => {
    const g = await connectWs(hub.app, '/ws?role=guest');
    const st = await g.next('state');
    expect(st.state.changeSeq).toBeGreaterThan(0);
    // trigger a change: changeSeq increases by one per broadcast
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    const next = await g.next('state');
    expect(next.state.changeSeq).toBe(st.state.changeSeq + 1);
    g.ws.terminate();
  });
});

describe('track clock', () => {
  const startedAt = () => hub.app.jukebox.session.state.nowPlaying?.startedAt;

  it('a reconnecting or `playing` player does not reset startedAt', async () => {
    // The track starts with no player online: the first connect starts its clock, once.
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    hub.clock.advance(30_000);
    let p = await player();
    const anchored = hub.clock.now;
    expect(startedAt()).toBe(anchored);
    const rev = hub.app.jukebox.session.revision;

    hub.clock.advance(2000);
    p.send({ type: 'event', kind: 'playing', revision: rev });
    p.send({ type: 'position', position: 2, playerState: 1, revision: rev });
    await flush(p);
    expect(startedAt()).toBe(anchored);

    for (let i = 0; i < 3; i++) {
      hub.clock.advance(2000);
      p.ws.terminate();
      await new Promise((r) => setTimeout(r, 20));
      p = await player();
      p.send({ type: 'event', kind: 'playing', revision: rev });
      await flush(p);
      expect(startedAt()).toBe(anchored);
    }
    // A second socket of the same player while the first is open changes nothing either.
    const q = await player();
    expect(startedAt()).toBe(anchored);
    expect(hub.app.jukebox.session.revision).toBe(rev);
    p.ws.terminate();
    q.ws.terminate();
  });

  it('a relaunch resumes the restored track at its last position, not its stale clock', async () => {
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    let p = await player();
    const rev = hub.app.jukebox.session.revision;
    hub.clock.advance(42_000);
    p.send({ type: 'position', position: 42, playerState: 1, revision: rev });
    await flush(p);
    p.ws.terminate();

    // The app is closed for three hours, then relaunched; the TV connects within the grace window.
    hub.clock.advance(3 * 3600_000);
    const app = await hub.restart();
    expect(app.jukebox.session.state.nowPlaying?.startedAt).toBeLessThan(hub.clock.now - 3600_000);
    p = await player();
    const st = await lastPlayerStateMsg(p);
    expect(app.jukebox.applyRestartRule()).toBe(false);
    expect(app.jukebox.session.revision).toBe(rev);
    expect(startedAt()).toBe(hub.clock.now - 42_000);
    expect(st.playback.nowPlaying?.startedAt).toBe(hub.clock.now - 42_000);

    // Re-anchored once: a reconnect later does not move it again.
    hub.clock.advance(5000);
    p.ws.terminate();
    await new Promise((r) => setTimeout(r, 20));
    p = await player();
    expect(startedAt()).toBe(hub.clock.now - 5000 - 42_000);
    p.ws.terminate();
  });
});

describe('restart rule', () => {
  it('restarts the interrupted track once, then skips it on a second restart', async () => {
    for (let i = 1; i <= 2; i++) {
      await admin('POST', '/api/admin/requests', { videoId: vid(i), idempotencyKey: `o${i}` });
    }
    const rev = hub.app.jukebox.session.revision;
    let app = await hub.restart();
    expect(app.jukebox.session.state.nowPlaying?.videoId).toBe(vid(1));
    expect(app.jukebox.applyRestartRule()).toBe(true);
    let s = app.jukebox.session.state;
    expect(s.revision).toBe(rev + 1);
    expect(s.nowPlaying).toMatchObject({ videoId: vid(1), restarted: true });

    app = await hub.restart();
    expect(app.jukebox.applyRestartRule()).toBe(true);
    s = app.jukebox.session.state;
    expect(s.nowPlaying?.videoId).toBe(vid(2));
    expect(s.history.at(-1)).toMatchObject({
      videoId: vid(1),
      status: 'skipped',
      skipReason: 'restart',
    });
  });

  it('does nothing when a player connects within the window', async () => {
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    const rev = hub.app.jukebox.session.revision;
    const app = await hub.restart();
    const p = await player();
    expect(app.jukebox.applyRestartRule()).toBe(false);
    expect(app.jukebox.session.revision).toBe(rev);
    p.ws.terminate();
  });

  it('the timer applies the rule after the grace period', async () => {
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    const rev = hub.app.jukebox.session.revision;
    const app = await hub.restart({ restartGraceMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(app.jukebox.session.revision).toBe(rev + 1);
  });

  it('keeps the queue while no player is online and starts fallback when one connects', async () => {
    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaTESTKEY0001' });
    hub.yt.playlists.set('PLfallback0002', { items: [{ id: vid(8) }] });
    await admin('POST', '/api/admin/playlists', { url: 'PLfallback0002' });
    expect(hub.app.jukebox.session.state.nowPlaying).toBeNull();
    hub.app.jukebox.applyRestartRule();
    expect(hub.app.jukebox.session.state.nowPlaying).toBeNull();
    const p = await player();
    expect((await lastPlayerState(p)).np?.videoId).toBe(vid(8));
    p.ws.terminate();
  });
});

describe('privacy', () => {
  it('serves privacy.json', async () => {
    const res = await hub.app.inject({ url: '/api/privacy.json' });
    const body = res.json();
    expect(body.sections.length).toBeGreaterThanOrEqual(8);
    const text = JSON.stringify(body);
    for (const needle of [
      'YouTube API Services',
      'policies.google.com/privacy',
      'Forget me',
      'not directed at children',
      'advertising',
      'cookie',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('guest projections contain no guestId, key, verifier or tokens', async () => {
    await admin('PATCH', '/api/admin/settings', {
      youtubeApiKey: 'AIzaSECRETKEY9876',
      wifi: { ssid: 'Party', security: 'WPA', hidden: false },
      wifiPassword: 'wifisecret1',
    });
    const g = new Guest(hub.app);
    const { guestId } = await g.hello('Eve');
    await g.request(vid(1), 'idem-key-123');
    await g.request(vid(1), 'idem-key-123');
    const ws = await connectWs(hub.app, '/ws?role=guest', { headers: { cookie: g.cookie } });
    const st = await ws.next('state');
    const session = (await g.req({ method: 'GET', url: '/api/session' })).body;
    const req = (await g.request(vid(1), 'idem-key-123')).body;
    for (const text of [JSON.stringify(st), session, req]) {
      for (const secret of [
        guestId,
        'AIzaSECRETKEY9876',
        '9876',
        'wifisecret1',
        'scrypt',
        creds.token,
        creds.playerToken,
        'idem-key-123',
        '192.168.1.50',
        'requesterGuestId',
        'idempotencyKey',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(JSON.parse(session).flags.hasApiKey).toBe(true);
    // admin sees no secrets either, only hasApiKey/apiKeyLast4/hasWifiPassword
    const settings = (await admin('GET', '/api/admin/settings')).json();
    expect(settings).toMatchObject({ hasApiKey: true, apiKeyLast4: '9876', hasWifiPassword: true });
    expect(JSON.stringify(settings)).not.toContain('AIzaSECRETKEY9876');
    expect(JSON.stringify(settings)).not.toContain('wifisecret1');
    // the Wi-Fi password reaches only the TV
    const p = await player();
    const tv = hub.app.jukebox.session.toPlayerState(creds.playerId);
    expect(tv.qr).toEqual({
      lanUrl: 'http://192.168.1.20:8080/',
      joinUrl: 'http://192.168.1.20:8080/',
      publicUrl: null,
      wifi: 'WIFI:T:WPA;S:Party;P:wifisecret1;;',
      wifiSsid: 'Party',
    });
    ws.ws.terminate();
    p.ws.terminate();
  });

  it('Forget me removes the name from queue and history projections', async () => {
    const p = await player();
    const g = new Guest(hub.app);
    const { guestId } = await g.hello('Frank');
    await g.request(vid(1));
    hub.clock.advance(6000);
    await g.request(vid(2));
    hub.clock.advance(6000);
    await g.request(vid(3));
    const s = await lastPlayerState(p);
    p.send({ type: 'event', kind: 'ended', revision: s.revision });
    await flush(p);
    let st = await adminState();
    expect(JSON.stringify(st)).toContain('Frank');
    expect(JSON.stringify(st)).toContain(guestId);

    const res = await g.req({ method: 'POST', url: '/api/guest/forget' });
    expect(res.json()).toEqual({ ok: true });
    expect(g.cookie).toBe('');
    st = await adminState();
    expect(JSON.stringify(st)).not.toContain('Frank');
    expect(JSON.stringify(st)).not.toContain(guestId);
    expect(st.recentHistory[0]).toMatchObject({
      videoId: vid(1),
      requesterName: null,
      requesterGuestId: null,
    });
    // persisted too
    const app = await hub.restart();
    const again = app.jukebox.session.toAdminState();
    expect(JSON.stringify(again)).not.toContain('Frank');
    // a new hello gets a new guest ID
    const g2 = new Guest(app);
    g2.cookie = '';
    expect((await g2.hello()).guestId).not.toBe(guestId);
  });

  it('admin delete guest data', async () => {
    const g = new Guest(hub.app);
    const { guestId } = await g.hello('Gail');
    await g.request(vid(1));
    expect((await admin('DELETE', `/api/admin/guests/${guestId}`)).json()).toEqual({ ok: true });
    expect(JSON.stringify(await adminState())).not.toContain('Gail');
    const hello = await g.hello();
    expect(hello.guestId).not.toBe(guestId);
  });
});
