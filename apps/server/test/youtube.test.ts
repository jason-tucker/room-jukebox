import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GuestState } from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseAddress, escapeWifi, wifiQrPayload } from '../src/lan.ts';
import { extractPlaylistId, extractVideoId, parseIsoDuration } from '../src/youtube/ids.ts';
import { nextPacificMidnight, normaliseQuery, pacificDay } from '../src/youtube/service.ts';
import { Guest, makeHub, setup, vid } from './helpers.ts';
import type { TestHub } from './helpers.ts';

describe('ID extraction', () => {
  const id = 'dQw4w9WgXcQ';
  it.each([
    [id],
    [`https://www.youtube.com/watch?v=${id}`],
    [`https://m.youtube.com/watch?feature=share&v=${id}&t=10`],
    [`https://youtu.be/${id}?si=abc`],
    [`https://www.youtube.com/shorts/${id}`],
    [`https://www.youtube.com/embed/${id}`],
    [`https://www.youtube.com/live/${id}?feature=share`],
    [`https://music.youtube.com/watch?v=${id}&list=RDAMVM`],
    [`Check out this video! https://youtu.be/${id} shared via the YouTube app`],
  ])('%s', (input) => {
    expect(extractVideoId(input)).toBe(id);
  });

  it('rejects non-YouTube text', () => {
    expect(extractVideoId('hello world')).toBeNull();
    expect(extractVideoId('https://vimeo.com/123456789')).toBeNull();
    expect(extractVideoId(`https://youtu.be/${id}x`)).toBeNull();
  });

  it('playlist IDs and durations', () => {
    expect(extractPlaylistId('https://www.youtube.com/playlist?list=PL1234567890abc')).toBe(
      'PL1234567890abc',
    );
    expect(extractPlaylistId('PL1234567890abc')).toBe('PL1234567890abc');
    expect(extractPlaylistId('nothing')).toBeNull();
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT4M')).toBe(240);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('bogus')).toBeNull();
  });

  it('normalises queries and computes the Pacific quota day', () => {
    expect(normaliseQuery('  Daft   PUNK\tone more ')).toBe('daft punk one more');
    // 2026-10-25 06:00 UTC is 23:00 on 10-24 in Los Angeles (PDT)
    const t = Date.UTC(2026, 9, 25, 6, 0);
    expect(pacificDay(t)).toBe('2026-10-24');
    expect(nextPacificMidnight(t)).toBe(Date.UTC(2026, 9, 25, 7, 0));
    // after the DST change (PST, UTC-8)
    expect(nextPacificMidnight(Date.UTC(2026, 10, 10, 12))).toBe(Date.UTC(2026, 10, 11, 8));
  });
});

describe('LAN and Wi-Fi QR', () => {
  it('escapes the WIFI: payload', () => {
    expect(escapeWifi('a;b,c:d"e\\f')).toBe('a\\;b\\,c\\:d\\"e\\\\f');
    expect(wifiQrPayload({ ssid: 'My;Net', security: 'WPA', hidden: true }, 'p:w')).toBe(
      'WIFI:T:WPA;S:My\\;Net;P:p\\:w;H:true;;',
    );
    expect(wifiQrPayload({ ssid: 'Open', security: 'nopass', hidden: false }, 'x')).toBe(
      'WIFI:T:nopass;S:Open;P:;H:false;;',
    );
    expect(wifiQrPayload(null, 'x')).toBeNull();
  });

  it('chooses the first real LAN address unless overridden', () => {
    const list = [
      { interface: 'docker0', address: '172.17.0.1', cidr: '172.17.0.1/16' },
      { interface: 'Ethernet 2', address: '169.254.3.4', cidr: '169.254.3.4/16' },
      { interface: 'Wi-Fi', address: '10.0.0.23', cidr: '10.0.0.23/24' },
    ];
    expect(chooseAddress(list, null)).toBe('10.0.0.23');
    expect(chooseAddress(list, '172.17.0.1')).toBe('172.17.0.1');
    expect(chooseAddress(list, '1.2.3.4')).toBe('10.0.0.23');
    expect(chooseAddress([], null)).toBe('127.0.0.1');
  });
});

describe('YouTube routes', () => {
  let hub: TestHub;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    hub.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  beforeEach(async () => {
    hub = await makeHub();
    hub.yt.add(
      { id: vid(1), title: 'Good song', channel: 'Band' },
      { id: vid(2), title: 'Gone', missing: true },
      { id: vid(3), title: 'Secret', privacy: 'private' },
      { id: vid(4), title: 'No embed', embeddable: false },
      { id: vid(5), title: 'Adults', ytRating: 'ytAgeRestricted' },
      { id: vid(6), title: 'Live now', live: 'live' },
      { id: vid(7), title: 'Epic', duration: 'PT12M' },
    );
    token = (await setup(hub.app, { youtubeApiKey: 'AIzaTESTKEY1234' })).token;
    // Data API search (the results-page default has its own tests in unofficial.test.ts)
    await admin('PATCH', '/api/admin/settings', { search: { source: 'api-first' } });
  });
  afterEach(async () => hub.close());

  it('resolve uses oEmbed without a key and videos.list with one', async () => {
    const g = new Guest(hub.app);
    const res = await g.req({
      method: 'GET',
      url: `/api/videos/resolve?input=${encodeURIComponent(`https://youtu.be/${vid(1)}`)}`,
    });
    expect(res.json()).toMatchObject({
      videoId: vid(1),
      title: 'Good song',
      playable: true,
      durationSec: 210,
    });
    expect(hub.yt.count('videos')).toBe(1);
    expect(hub.yt.calls.find((c) => c.endpoint === 'videos')?.params.get('part')).toBe(
      'snippet,contentDetails,status',
    );
    const bad = await g.req({ method: 'GET', url: '/api/videos/resolve?input=hello' });
    expect(bad.statusCode).toBe(400);

    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: null });
    const noKey = await g.req({ method: 'GET', url: `/api/videos/resolve?input=${vid(1)}` });
    expect(noKey.json()).toMatchObject({ title: 'Good song', playable: true });
    expect(hub.yt.count('oembed')).toBeGreaterThan(0);
    const gone = await g.req({ method: 'GET', url: `/api/videos/resolve?input=${vid(2)}` });
    expect(gone.json()).toMatchObject({ playable: false, reason: 'not-found' });
  });

  it.each([
    [2, 'not-found', /isn't available on YouTube/],
    [3, 'private', /private on YouTube/],
    [4, 'not-embeddable', /doesn't allow it to play outside YouTube/],
    [5, 'age-restricted', /age-restricted on YouTube/],
    [6, 'live', /live stream/],
    [7, 'too-long', /8-minute limit, set by the owner/],
  ])('pre-screen rejects video %i as %s with a plain-words message', async (n, code, message) => {
    const g = new Guest(hub.app);
    const res = await g.request(vid(n));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe(code);
    expect(res.json().error.message).toMatch(message);
    expect(hub.app.jukebox.session.state.nowPlaying).toBeNull();
  });

  it('search: submit-only, cached 24 h, budget exhaustion returns 429 and keeps playback', async () => {
    const g = new Guest(hub.app);
    await g.hello();
    expect((await g.request(vid(1))).statusCode).toBe(201);

    const first = await g.req({
      method: 'POST',
      url: '/api/search',
      payload: { q: 'Party  Songs' },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.cached).toBe(false);
    expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(vid),
    );
    // unplayable rows keep their position, greyed with the reason
    expect(body.results[6]).toMatchObject({ playable: false, reason: 'too-long', source: 'owner' });
    expect(body.results[4]).toMatchObject({
      playable: false,
      reason: 'age-restricted',
      source: 'youtube',
    });
    const call = hub.yt.calls.find((c) => c.endpoint === 'search');
    expect(Object.fromEntries(call?.params ?? [])).toMatchObject({
      type: 'video',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '50',
      q: 'Party  Songs',
    });

    const again = await g.req({
      method: 'POST',
      url: '/api/search',
      payload: { q: 'party songs' },
    });
    expect(again.json().cached).toBe(true);
    expect(hub.yt.count('search')).toBe(1);

    // spend the rest of the guests' share (100 total - 20 owner reserve) via the stored usage
    await admin('PATCH', '/api/admin/settings', {
      limits: {
        maxPendingPerGuest: 5,
        cooldownSec: 5,
        allowDuplicates: true,
        maxDurationSec: 480,
        search: {
          perGuestPerDay: 10,
          perGuestIntervalSec: 0,
          perIpPerDay: 10,
          publicPerDay: 20,
          ownerReserve: 1,
          dailyTotal: 2,
        },
      },
      search: { source: 'api-only' },
    });
    const blocked = await g.req({ method: 'POST', url: '/api/search', payload: { q: 'other' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('search-budget');
    const state = (await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState;
    expect(state.search).toEqual({
      enabled: false,
      remaining: 0,
      low: true,
      provider: 'youtube-api',
    });
    expect(state.playback.nowPlaying?.videoId).toBe(vid(1));

    // the owner reserve still works, then the daily quota
    const owner = await admin('POST', '/api/admin/search', { q: 'owner pick' });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().remaining).toBe(0);
    const out = await admin('POST', '/api/admin/search', { q: 'owner pick 2' });
    expect(out.statusCode).toBe(429);
    expect(out.json().error.code).toBe('daily-quota');
    expect((await admin('GET', '/api/admin/searches')).json()).toMatchObject({
      guests: 0,
      owner: 0,
      dailyTotal: 2,
    });

    // the paste flow keeps working
    hub.clock.advance(6000);
    expect((await g.request(vid(1))).statusCode).toBe(201);
  });

  it("YouTube's quotaExceeded maps to daily-quota (api-only)", async () => {
    await admin('PATCH', '/api/admin/settings', { search: { source: 'api-only' } });
    hub.yt.quotaExceeded = true;
    const g = new Guest(hub.app);
    const res = await g.req({ method: 'POST', url: '/api/search', payload: { q: 'x' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('daily-quota');
    expect((await admin('GET', '/api/admin/searches')).json().owner).toBe(0);
  });

  it('search is 503 without a key (api-only)', async () => {
    await admin('PATCH', '/api/admin/settings', {
      youtubeApiKey: null,
      search: { source: 'api-only' },
    });
    const g = new Guest(hub.app);
    const res = await g.req({ method: 'POST', url: '/api/search', payload: { q: 'x' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('search-disabled');
    const st = (await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState;
    expect(st.search).toEqual({ enabled: false, remaining: null, low: false });
  });

  it('playlist import: public/unlisted only; 403 → playlist-private, 404 → playlist-not-found', async () => {
    hub.yt.playlists.set('PLpublic00001', {
      items: [
        { id: vid(1) },
        { id: vid(3), privacy: 'private' },
        { id: vid(7), privacy: 'unlisted' },
      ],
    });
    hub.yt.playlists.set('PLlocked00001', { status: 403, items: [] });
    const ok = await admin('POST', '/api/admin/playlists', {
      url: 'https://www.youtube.com/playlist?list=PLpublic00001',
    });
    expect(ok.json()).toMatchObject({
      playlistId: 'PLpublic00001',
      videoCount: 2,
      title: 'Playlist PLpublic00001',
    });
    const priv = await admin('POST', '/api/admin/playlists', { url: 'PLlocked00001' });
    expect(priv.statusCode).toBe(422);
    expect(priv.json().error.code).toBe('playlist-private');
    const missing = await admin('POST', '/api/admin/playlists', { url: 'PLmissing0001' });
    expect(missing.json().error.code).toBe('playlist-not-found');
    const refresh = await admin('POST', `/api/admin/playlists/${ok.json().id}/refresh`);
    expect(refresh.statusCode).toBe(200);
    const st = (await admin('GET', '/api/admin/session')).json();
    expect(st.settings.fallbackPlaylists).toHaveLength(1);
    // vid(7) is over the length limit, so only vid(1) is in the pool
    expect(st.fallback.poolSize).toBe(1);
  });

  it('logs quota use', async () => {
    const g = new Guest(hub.app);
    await g.req({ method: 'POST', url: '/api/search', payload: { q: 'log me' } });
    const db = new DatabaseSync(join(hub.dataDir, 'data.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT endpoint, units, status FROM quota_log ORDER BY seq').all();
      expect(rows).toEqual([
        { endpoint: 'search.list', units: 1, status: 200 },
        { endpoint: 'videos.list', units: 1, status: 200 },
      ]);
    } finally {
      db.close();
    }
  });
});
