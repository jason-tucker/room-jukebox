import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GuestState } from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/youtube/client.ts';
import {
  extractInitialData,
  parseClock,
  searchUnofficial,
  UnofficialSearchError,
} from '../src/youtube/unofficial.ts';
import {
  CONSENT_PAGE,
  EMPTY_PAGE,
  FIXTURE_PAGE,
  resultsPage,
  WINDOW_STYLE_PAGE,
} from './fixtures/results-page.ts';
import { Guest, makeHub, setup, vid } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const html = (body: string, status = 200): FetchLike => {
  return async () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
};

async function failure(p: Promise<unknown>): Promise<UnofficialSearchError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof UnofficialSearchError) return err;
    throw err;
  }
  throw new Error('expected UnofficialSearchError');
}

describe('unofficial search parser', () => {
  it('maps videoRenderers in YouTube order and skips shelves, ads, playlists and channels', async () => {
    const cards = await searchUnofficial('daft punk', { fetch: html(FIXTURE_PAGE) });
    expect(cards).toEqual([
      {
        videoId: 'aaaaaaaaaaa',
        title: 'Daft Punk - One More Time };',
        channelTitle: 'Daft Punk',
        thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hq720.jpg',
        durationSec: 321,
        playable: true,
      },
      {
        videoId: 'bbbbbbbbbbb',
        title: 'Party Mix 2026',
        channelTitle: 'DJ "Quotes" Mixer',
        thumbnail: 'https://i.ytimg.com/vi/bbbbbbbbbbb/hq720.jpg',
        durationSec: 3723,
        playable: true,
      },
      {
        videoId: 'ccccccccccc',
        title: 'Lofi radio 24/7',
        channelTitle: 'Lofi Girl',
        thumbnail: 'https://i.ytimg.com/vi/ccccccccccc/hq720.jpg',
        durationSec: null,
        playable: false,
        reason: 'live',
        source: 'youtube',
        message: expect.stringMatching(/live stream/),
      },
    ]);
  });

  it('requests the videos-only results page with browser headers and the consent cookie', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(FIXTURE_PAGE);
    };
    await searchUnofficial('  AC/DC & friends ', { fetch });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'https://www.youtube.com/results?search_query=AC%2FDC%20%26%20friends&sp=EgIQAQ%253D%253D',
    );
    expect(seen[0]?.headers['User-Agent']).toMatch(/Chrome\/\d+/);
    expect(seen[0]?.headers['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(seen[0]?.headers.Cookie).toBe('CONSENT=YES+cb; SOCS=CAI');
  });

  it('reads window["ytInitialData"] too, and caps results at 50', async () => {
    const one = await searchUnofficial('x', { fetch: html(WINDOW_STYLE_PAGE) });
    expect(one.map((c) => [c.videoId, c.durationSec])).toEqual([['ddddddddddd', 210]]);
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: vid(i),
      title: `Song ${i}`,
      length: '3:00',
    }));
    const capped = await searchUnofficial('x', { fetch: html(resultsPage(many)) });
    expect(capped).toHaveLength(50);
    expect(capped[49]?.videoId).toBe(vid(49));
  });

  it('fails soft with a typed error', async () => {
    expect((await failure(searchUnofficial('x', { fetch: html(CONSENT_PAGE) }))).kind).toBe(
      'no-data',
    );
    expect((await failure(searchUnofficial('x', { fetch: html(EMPTY_PAGE) }))).kind).toBe(
      'no-results',
    );
    expect((await failure(searchUnofficial('x', { fetch: html('', 429) }))).kind).toBe('http');
    const offline: FetchLike = async () => {
      throw new Error('offline');
    };
    expect((await failure(searchUnofficial('x', { fetch: offline }))).kind).toBe('network');
    expect(extractInitialData('var ytInitialData = {"broken": ')).toBeNull();
  });

  it('parses clock lengths', () => {
    expect(parseClock('3:30')).toBe(210);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('45')).toBe(45);
    expect(parseClock('LIVE')).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });
});

describe('search sources', () => {
  let hub: TestHub;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    hub.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const search = (g: Guest, q: string) =>
    g.req({ method: 'POST', url: '/api/search', payload: { q } });
  const state = async (g: Guest) =>
    ((await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState).search;
  /** Guests get no searches (owner keeps 1 of 1). */
  const exhaustGuests = (extra: object = {}) =>
    admin('PATCH', '/api/admin/settings', {
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
          dailyTotal: 1,
        },
      },
      ...extra,
    });

  const page = resultsPage([
    { id: vid(1), title: 'Page: Good song', length: '3:30' },
    { id: vid(4), title: 'Page: No embed', length: '4:00' },
    { id: vid(7), title: 'Page: Epic', length: '12:00' },
    { id: vid(8), title: 'Page: Live', channel: 'Radio' },
  ]);

  beforeEach(async () => {
    hub = await makeHub();
    hub.yt.add(
      { id: vid(1), title: 'Good song', channel: 'Band' },
      { id: vid(4), title: 'No embed', embeddable: false },
      { id: vid(7), title: 'Epic', duration: 'PT12M' },
      { id: vid(8), title: 'Live', live: 'live' },
    );
    hub.yt.resultsHtml = page;
    token = (await setup(hub.app, { youtubeApiKey: 'AIzaTESTKEY1234' })).token;
  });
  afterEach(async () => hub.close());

  /** Rewrites the stored settings JSON's `search` (as an older version left it), then restarts. */
  const storeSearch = async (search: object | undefined) => {
    const db = new DatabaseSync(join(hub.dataDir, 'data.db'));
    try {
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (search === undefined) delete data.search;
      else data.search = search;
      db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data));
    } finally {
      db.close();
    }
    await hub.restart();
  };

  it('settings: search.source defaults to page, persists, validates', async () => {
    expect((await admin('GET', '/api/admin/settings')).json().search).toEqual({
      source: 'page',
      mirror: true,
    });
    const api = await admin('PATCH', '/api/admin/settings', { search: { source: 'api-only' } });
    expect(api.statusCode).toBe(200);
    expect(api.json().search).toEqual({ source: 'api-only', mirror: true });
    // other patches leave it alone; it survives a restart
    await admin('PATCH', '/api/admin/settings', { roomName: 'Den' });
    await hub.restart();
    expect((await admin('GET', '/api/admin/settings')).json()).toMatchObject({
      roomName: 'Den',
      search: { source: 'api-only' },
    });
    expect((await admin('GET', '/api/admin/session')).json().settings.search).toEqual({
      source: 'api-only',
      mirror: true,
    });
    for (const search of [{ source: 'web' }, { unofficialFallback: 'yes' }, {}]) {
      expect((await admin('PATCH', '/api/admin/settings', { search })).statusCode).toBe(400);
    }
  });

  it('settings: the legacy unofficialFallback boolean maps to a source on PATCH', async () => {
    const on = await admin('PATCH', '/api/admin/settings', {
      search: { unofficialFallback: true },
    });
    expect(on.json().search).toEqual({ source: 'api-first', mirror: true });
    const off = await admin('PATCH', '/api/admin/settings', {
      search: { unofficialFallback: false },
    });
    expect(off.json().search).toEqual({ source: 'api-only', mirror: true });
  });

  it.each([
    ['unofficialFallback false', { unofficialFallback: false }, 'api-only'],
    ['unofficialFallback true (the old default)', { unofficialFallback: true }, 'page'],
    ['no search key (pre-0.0.5)', undefined, 'page'],
  ])('migrates a stored %s to source %s', async (_name, stored, source) => {
    await storeSearch(stored);
    expect((await admin('GET', '/api/admin/settings')).json().search).toEqual({
      source,
      mirror: true,
    });
    const db = new DatabaseSync(join(hub.dataDir, 'data.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
      expect(JSON.parse(row.data).search).toEqual({ source });
    } finally {
      db.close();
    }
  });

  describe('page (default)', () => {
    it('guests and the owner read the results page even with a key; no search quota is spent', async () => {
      const g = new Guest(hub.app);
      await g.hello();
      expect(await state(g)).toEqual({
        enabled: true,
        remaining: null,
        low: false,
        provider: 'unofficial',
      });
      const res = await search(g, 'party');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ provider: 'unofficial', remaining: null, cached: false });
      expect(hub.yt.count('search')).toBe(0);
      expect(hub.yt.count('results')).toBe(1);
      // pre-screened with videos.list because a key exists
      expect(hub.yt.count('videos')).toBe(1);
      expect(body.results[0]).toMatchObject({ title: 'Good song', playable: true });
      expect(body.results[1]).toMatchObject({ playable: false, reason: 'not-embeddable' });

      const owner = await admin('POST', '/api/admin/search', { q: 'owner pick' });
      expect(owner.json()).toMatchObject({ provider: 'unofficial', remaining: null });
      expect(hub.yt.count('search')).toBe(0);
      expect((await admin('GET', '/api/admin/searches')).json()).toMatchObject({
        guests: 80,
        owner: 100,
      });
      expect((await admin('GET', '/api/admin/session')).json().search).toEqual({
        enabled: true,
        remaining: null,
        low: false,
        provider: 'unofficial',
      });
    });

    it('caches 24 h as unofficial and keeps the per-guest interval', async () => {
      const g = new Guest(hub.app);
      expect((await search(g, 'Party')).statusCode).toBe(200);
      const hit = await search(g, ' party ');
      expect(hit.json()).toMatchObject({ provider: 'unofficial', cached: true });
      const wait = await search(g, 'other');
      expect(wait.statusCode).toBe(429);
      expect(wait.json().error.code).toBe('search-budget');
      hub.clock.advance(15_000);
      expect((await search(g, 'other')).statusCode).toBe(200);
      expect(hub.yt.count('results')).toBe(2);
      hub.clock.advance(24 * 60 * 60 * 1000);
      expect((await search(g, 'party')).json().cached).toBe(false);
    });
  });

  describe('api-first and api-only', () => {
    beforeEach(async () => {
      await admin('PATCH', '/api/admin/settings', { search: { source: 'api-first' } });
    });

    it('official mode: provider youtube-api with the remaining count', async () => {
      const g = new Guest(hub.app);
      await g.hello();
      expect(await state(g)).toEqual({
        enabled: true,
        remaining: 10,
        low: true,
        provider: 'youtube-api',
      });
      const res = await search(g, 'party');
      expect(res.json()).toMatchObject({ provider: 'youtube-api', cached: false, remaining: 9 });
      // the owner/admin view (no guest) shows the guests' shared remainder
      expect((await admin('GET', '/api/admin/session')).json().search).toEqual({
        enabled: true,
        remaining: 79,
        low: false,
        provider: 'youtube-api',
      });
      expect(hub.yt.count('results')).toBe(0);
    });

    it('budget exhausted → unofficial results, pre-screened with videos.list; requests still work', async () => {
      await exhaustGuests();
      const g = new Guest(hub.app);
      await g.hello();
      expect(await state(g)).toEqual({
        enabled: true,
        remaining: null,
        low: false,
        provider: 'unofficial',
      });
      const res = await search(g, 'Party  Songs');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ provider: 'unofficial', remaining: null, cached: false });
      expect(hub.yt.count('search')).toBe(0);
      expect(hub.yt.count('results')).toBe(1);
      expect(hub.yt.count('videos')).toBe(1);
      expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(
        [1, 4, 7, 8].map(vid),
      );
      // videos.list rows win over the page: titles, embeddable, length, live
      expect(body.results[0]).toMatchObject({ title: 'Good song', playable: true });
      expect(body.results[1]).toMatchObject({ playable: false, reason: 'not-embeddable' });
      expect(body.results[2]).toMatchObject({
        playable: false,
        reason: 'too-long',
        source: 'owner',
      });
      expect(body.results[3]).toMatchObject({ playable: false, reason: 'live' });
      // no budget spent
      expect((await admin('GET', '/api/admin/searches')).json()).toMatchObject({
        guests: 0,
        owner: 1,
      });

      const req = await g.request(vid(1));
      expect(req.statusCode).toBe(201);
      expect(hub.app.jukebox.session.state.nowPlaying?.videoId).toBe(vid(1));
    });

    it('api-first with no key → unofficial directly, trusting the page', async () => {
      await admin('PATCH', '/api/admin/settings', { youtubeApiKey: null });
      const g = new Guest(hub.app);
      expect(await state(g)).toEqual({
        enabled: true,
        remaining: null,
        low: false,
        provider: 'unofficial',
      });
      const res = await search(g, 'party');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ provider: 'unofficial', remaining: null, cached: false });
      expect(hub.yt.count('videos')).toBe(0);
      expect(body.results[0]).toMatchObject({
        videoId: vid(1),
        title: 'Page: Good song',
        durationSec: 210,
        playable: true,
      });
      // page length still meets the owner's limit; no embeddable info without a key
      expect(body.results[1]).toMatchObject({ title: 'Page: No embed', playable: true });
      expect(body.results[2]).toMatchObject({ playable: false, reason: 'too-long' });
      expect(body.results[3]).toMatchObject({
        durationSec: null,
        playable: false,
        reason: 'live',
        source: 'youtube',
      });
      const st = (await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState;
      expect(st.flags.hasApiKey).toBe(false);
      expect((await g.request(vid(1))).statusCode).toBe(201);
    });

    it('cache hits return the stored provider without fetching', async () => {
      await admin('PATCH', '/api/admin/settings', { youtubeApiKey: null });
      const g = new Guest(hub.app);
      await search(g, 'party songs');
      hub.yt.resultsHtml = null;
      const again = await search(g, '  PARTY songs ');
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ provider: 'unofficial', cached: true, remaining: null });
      expect(again.json().results[3]).toMatchObject({ reason: 'live', title: 'Page: Live' });
      expect(hub.yt.count('results')).toBe(1);

      // an official cache row keeps its provider even when the next miss would be unofficial
      await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaTESTKEY1234' });
      hub.clock.advance(60_000); // past the per-guest search interval
      expect((await search(g, 'official')).json().provider).toBe('youtube-api');
      await exhaustGuests();
      const hit = await search(g, 'official');
      expect(hit.json()).toMatchObject({ provider: 'youtube-api', cached: true, remaining: 0 });
      expect(hub.yt.count('search')).toBe(1);
      expect(hub.yt.count('results')).toBe(1);
    });

    it('api-only → 429 / 503 as before', async () => {
      await exhaustGuests({ search: { source: 'api-only' } });
      const g = new Guest(hub.app);
      expect(await state(g)).toEqual({
        enabled: false,
        remaining: 0,
        low: true,
        provider: 'youtube-api',
      });
      const blocked = await search(g, 'x');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('search-budget');

      await admin('PATCH', '/api/admin/settings', { youtubeApiKey: null });
      expect(await state(g)).toEqual({ enabled: false, remaining: null, low: false });
      const off = await search(g, 'x');
      expect(off.statusCode).toBe(503);
      expect(off.json().error.code).toBe('search-disabled');
      expect(hub.yt.count('results')).toBe(0);
    });

    it.each([
      ['consent page', CONSENT_PAGE],
      ['empty results', EMPTY_PAGE],
    ])('%s → 502 youtube-unavailable', async (_name, body) => {
      await exhaustGuests();
      hub.yt.resultsHtml = body;
      const res = await search(new Guest(hub.app), 'x');
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('youtube-unavailable');
    });

    it('the per-guest interval still answers 429 on the fallback path', async () => {
      await admin('PATCH', '/api/admin/settings', {
        youtubeApiKey: null,
        limits: {
          maxPendingPerGuest: 5,
          cooldownSec: 5,
          allowDuplicates: true,
          maxDurationSec: 480,
          search: {
            perGuestPerDay: 10,
            perGuestIntervalSec: 5,
            perIpPerDay: 10,
            publicPerDay: 20,
            ownerReserve: 1,
            dailyTotal: 1,
          },
        },
      });
      const g = new Guest(hub.app);
      expect((await search(g, 'one')).statusCode).toBe(200);
      const wait = await search(g, 'two');
      expect(wait.statusCode).toBe(429);
      expect(wait.json().error).toMatchObject({ code: 'search-budget', retryAfterSec: 5 });
      expect(wait.headers['retry-after']).toBe('5');
      hub.clock.advance(5000);
      expect((await search(g, 'two')).statusCode).toBe(200);
    });

    it("YouTube's quotaExceeded falls back on api-first", async () => {
      hub.yt.quotaExceeded = true;
      const res = await search(new Guest(hub.app), 'x');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ provider: 'unofficial', remaining: null });
      expect((await admin('GET', '/api/admin/searches')).json().owner).toBe(0);
    });

    it('owner search uses the reserve, then falls back', async () => {
      await exhaustGuests();
      const first = await admin('POST', '/api/admin/search', { q: 'owner pick' });
      expect(first.json()).toMatchObject({ provider: 'youtube-api', remaining: 0 });
      expect(hub.yt.count('search')).toBe(1);
      const second = await admin('POST', '/api/admin/search', { q: 'owner pick 2' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ provider: 'unofficial', remaining: null });
      expect(hub.yt.count('search')).toBe(1);

      await admin('PATCH', '/api/admin/settings', { search: { source: 'api-only' } });
      const off = await admin('POST', '/api/admin/search', { q: 'owner pick 3' });
      expect(off.statusCode).toBe(429);
      expect(off.json().error.code).toBe('daily-quota');
    });
  });
});
