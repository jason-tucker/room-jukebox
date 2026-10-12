import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/youtube/client.ts';
import { parseSuggestions, SuggestService, suggestUrl } from '../src/youtube/suggest.ts';
import { Guest, makeHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const JSONP = `window.google.ac.h(["daft p",[["daft punk",0,[512,433]],["daft punk get lucky",0,[512]],["daft punk one more time",0,[512]]],{"k":1,"q":"abc"}])`;
const JSON_SHAPE = `["daft p",["daft punk","daft punk around the world"]]`;
const MANY = `window.google.ac.h(["a",[${Array.from({ length: 14 }, (_, i) => `["a${i}",0]`).join(',')}],{}])`;

/** A fake suggest service answering `body` and recording each requested URL. */
function fake(body: string | (() => never), status = 200) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (typeof body === 'function') body();
    return new Response(body as string, {
      status,
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  };
  return { urls, fetch };
}

describe('suggestion parsing', () => {
  it('reads the JSONP shape (client=youtube)', () => {
    expect(parseSuggestions(JSONP)).toEqual([
      'daft punk',
      'daft punk get lucky',
      'daft punk one more time',
    ]);
  });
  it('reads the plain JSON shape', () => {
    expect(parseSuggestions(JSON_SHAPE)).toEqual(['daft punk', 'daft punk around the world']);
  });
  it('caps at 10, handles empty lists, throws on junk', () => {
    expect(parseSuggestions(MANY)).toHaveLength(10);
    expect(parseSuggestions('window.google.ac.h(["zzqx",[],{}])')).toEqual([]);
    expect(() => parseSuggestions('<html>consent</html>')).toThrow();
  });
  it('builds the suggest URL', () => {
    expect(suggestUrl('ac/dc & co')).toBe(
      'https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=en&q=ac%2Fdc%20%26%20co',
    );
  });
});

describe('SuggestService', () => {
  const make = (fetch: FetchLike) => {
    const clock = { now: 1_000_000 };
    return { clock, svc: new SuggestService({ fetch, now: () => clock.now }) };
  };

  it('caches 10 minutes per normalised prefix', async () => {
    const f = fake(JSONP);
    const { clock, svc } = make(f.fetch);
    expect(await svc.suggest('Daft  P', '1.1.1.1')).toHaveLength(3);
    clock.now += 1000;
    expect(await svc.suggest(' daft p', '1.1.1.1')).toHaveLength(3);
    expect(f.urls).toEqual([suggestUrl('daft p')]);
    clock.now += 10 * 60 * 1000;
    await svc.suggest('daft p', '1.1.1.1');
    expect(f.urls).toHaveLength(2);
  });

  it('rate-limits each source IP to one request per 300 ms', async () => {
    const f = fake(JSONP);
    const { clock, svc } = make(f.fetch);
    expect(await svc.suggest('da', '1.1.1.1')).not.toBeNull();
    clock.now += 299;
    expect(await svc.suggest('daf', '1.1.1.1')).toBeNull();
    expect(await svc.suggest('daf', '2.2.2.2')).not.toBeNull();
    clock.now += 1;
    expect(await svc.suggest('daft', '1.1.1.1')).not.toBeNull();
  });

  it('fails soft to an empty list (and does not cache failures)', async () => {
    const down = make(
      fake(() => {
        throw new Error('offline');
      }).fetch,
    );
    expect(await down.svc.suggest('x', '1.1.1.1')).toEqual([]);
    const http = fake('nope', 503);
    const h = make(http.fetch);
    expect(await h.svc.suggest('x', '1.1.1.1')).toEqual([]);
    h.clock.now += 300;
    await h.svc.suggest('x', '1.1.1.1');
    expect(http.urls).toHaveLength(2);
    expect(await make(fake('<html></html>').fetch).svc.suggest('x', '1.1.1.1')).toEqual([]);
    const blank = fake(JSONP);
    expect(await make(blank.fetch).svc.suggest('   ', '1.1.1.1')).toEqual([]);
    expect(blank.urls).toHaveLength(0);
  });
});

describe('GET /api/search/suggest', () => {
  let hub: TestHub;
  afterEach(async () => hub.close());

  it('answers suggestions, 204 for extras within 300 ms, and [] on failure', async () => {
    let body = JSON_SHAPE;
    hub = await makeHub({ fetch: async () => new Response(body) });
    const g = new Guest(hub.app);
    const ok = await g.req({ method: 'GET', url: '/api/search/suggest?q=daft%20p' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ suggestions: ['daft punk', 'daft punk around the world'] });

    const dropped = await g.req({ method: 'GET', url: '/api/search/suggest?q=daft%20pu' });
    expect(dropped.statusCode).toBe(204);
    expect(dropped.body).toBe('');
    // another phone is not affected
    const other = await new Guest(hub.app, '192.168.1.51').req({
      method: 'GET',
      url: '/api/search/suggest?q=daft%20pu',
    });
    expect(other.statusCode).toBe(200);

    hub.clock.advance(300);
    body = 'garbage';
    const empty = await g.req({ method: 'GET', url: '/api/search/suggest?q=zzqx' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ suggestions: [] });

    hub.clock.advance(300);
    const none = await g.req({ method: 'GET', url: '/api/search/suggest' });
    expect(none.json()).toEqual({ suggestions: [] });
  });
});
