import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filterResponseHeaders,
  MIRROR_UA,
  RateLimiter,
  rescopeSetCookie,
  rewriteHtml,
  rewriteLocation,
  rewriteText,
  upstreamCookie,
  upstreamUrl,
  videoIdFromPath,
  watchPage,
} from '../src/youtube/mirror.ts';
import { MIRROR_HEAD_SCRIPT, MIRROR_PICK_SCRIPT } from '../src/youtube/mirror-scripts.ts';
import { makeHub, setup } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const O = 'http://192.168.1.20:8080';

describe('rewriteText', () => {
  it('maps m., www. and bare youtube.com to <origin>/yt', () => {
    expect(rewriteText('a https://m.youtube.com/results b', O)).toBe(`a ${O}/yt/results b`);
    expect(rewriteText('"https://www.youtube.com/s/x.js"', O)).toBe(`"${O}/yt/s/x.js"`);
    expect(rewriteText('https://youtube.com', O)).toBe(`${O}/yt`);
    expect(rewriteText('http://www.youtube.com/', O)).toBe(`${O}/yt/`);
  });
  it('maps protocol-relative forms', () => {
    expect(rewriteText('src="//m.youtube.com/a"', O)).toBe(`src="${O}/yt/a"`);
    expect(rewriteText('url(//www.youtube.com/b)', O)).toBe(`url(${O}/yt/b)`);
  });
  it('keeps the escaping of JSON and JS string forms', () => {
    expect(rewriteText('"https:\\/\\/www.youtube.com\\/watch"', O)).toBe(
      '"http:\\/\\/192.168.1.20:8080\\/yt\\/watch"',
    );
    expect(rewriteText('"https:\\x2F\\x2Fm.youtube.com"', O)).toBe(
      '"http:\\x2F\\x2F192.168.1.20:8080\\x2Fyt"',
    );
    expect(rewriteText('"\\u002F\\u002Fwww.youtube.com"', O)).toBe(
      '"http:\\u002F\\u002F192.168.1.20:8080\\u002Fyt"',
    );
  });
  it('leaves image, video, font and other hosts direct', () => {
    const direct = [
      'https://i.ytimg.com/vi/abc/mqdefault.jpg',
      'https://yt3.ggpht.com/x',
      'https://rr1---sn-abc.googlevideo.com/videoplayback',
      'https://fonts.gstatic.com/s/roboto.woff2',
      'https://music.youtube.com/',
      'https://www.youtube.com.evil.example/',
      'https://www.youtube.community/',
      'https://www.gstatic.com/other/thing.js',
      'https://accounts.google.com/ServiceLogin',
    ];
    for (const u of direct) expect(rewriteText(u, O)).toBe(u);
  });
  it('mounts the suggest host and gstatic YouTube icons under /yt', () => {
    expect(rewriteText('https://suggestqueries-clients6.youtube.com/complete/search?q=a', O)).toBe(
      `${O}/yt/_suggest/complete/search?q=a`,
    );
    expect(rewriteText('https://www.gstatic.com/youtube/img/icons/logo.svg', O)).toBe(
      `${O}/yt/_gstatic/youtube/img/icons/logo.svg`,
    );
    expect(upstreamUrl('/_suggest/complete/search?q=a')).toBe(
      'https://suggestqueries-clients6.youtube.com/complete/search?q=a',
    );
    expect(upstreamUrl('/_gstatic/youtube/img/x.svg')).toBe(
      'https://www.gstatic.com/youtube/img/x.svg',
    );
  });
  it('routes paths upstream: m. by default, www for /s/player and /yts', () => {
    expect(upstreamUrl('/results?search_query=a')).toBe(
      'https://m.youtube.com/results?search_query=a',
    );
    expect(upstreamUrl('/youtubei/v1/search')).toBe('https://m.youtube.com/youtubei/v1/search');
    expect(upstreamUrl('/s/player/abc/base.js')).toBe(
      'https://www.youtube.com/s/player/abc/base.js',
    );
    expect(upstreamUrl('/yts/x.css')).toBe('https://www.youtube.com/yts/x.css');
  });
});

describe('rewriteHtml', () => {
  const html =
    '<html><head><base href="https://m.youtube.com/"><script src="/static/a.js"></script>' +
    '<link href="//fonts.googleapis.com/css2"></head><body><a href="/watch?v=abcdefghijk">x</a>' +
    '<img src="https://i.ytimg.com/vi/x/1.jpg"><form action="/results"></form></body></html>';
  const out = rewriteHtml(html, O);

  it('moves root-relative attributes under /yt and leaves protocol-relative alone', () => {
    expect(out).toContain('<script src="/yt/static/a.js">');
    expect(out).toContain('<a href="/yt/watch?v=abcdefghijk">');
    expect(out).toContain('<form action="/yt/results">');
    expect(out).toContain('<link href="//fonts.googleapis.com/css2">');
    expect(out).toContain('<img src="https://i.ytimg.com/vi/x/1.jpg">');
  });
  it('rewrites <base>, adds no-referrer and both scripts in the right places', () => {
    expect(out).toContain(`<base href="${O}/yt/">`);
    expect(out.indexOf('<meta name="referrer" content="no-referrer">')).toBe(
      out.indexOf('<head>') + '<head>'.length,
    );
    const head = out.indexOf(MIRROR_HEAD_SCRIPT);
    expect(head).toBeGreaterThan(0);
    expect(head).toBeLessThan(out.indexOf('<base'));
    expect(out.indexOf(MIRROR_PICK_SCRIPT)).toBeLessThan(out.indexOf('</body>'));
    expect(out.indexOf(MIRROR_PICK_SCRIPT)).toBeGreaterThan(out.indexOf('<form'));
  });
  it('does not double-prefix /yt/ attributes', () => {
    expect(rewriteHtml('<head></head><img src="/yt/a.png">', O)).toContain('src="/yt/a.png"');
  });
  it('the injected scripts parse as JavaScript', () => {
    expect(() => new Function(MIRROR_HEAD_SCRIPT)).not.toThrow();
    expect(() => new Function(MIRROR_PICK_SCRIPT)).not.toThrow();
  });
});

describe('headers and cookies', () => {
  it('keeps Content-Type and Cache-Control, drops framing, CSP, COOP/COEP/CORP, HSTS, reporting', () => {
    const h = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
      'content-security-policy-report-only': 'x',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-site',
      'strict-transport-security': 'max-age=1',
      'report-to': '{}',
      nel: '{}',
      'content-encoding': 'gzip',
      'content-length': '12',
      'alt-svc': 'h3',
    });
    expect(filterResponseHeaders(h)).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });

  it('re-scopes Set-Cookie to the hub origin', () => {
    expect(
      rescopeSetCookie(
        'YSC=abc; Domain=.youtube.com; Path=/; Secure; HttpOnly; SameSite=none; Partitioned',
      ),
    ).toBe('YSC=abc; Path=/; HttpOnly');
    expect(
      rescopeSetCookie(
        'PREF=f6=1; Expires=Tue, 13-Apr-2027 04:28:31 GMT; path=/; domain=.youtube.com',
      ),
    ).toBe('PREF=f6=1; Expires=Tue, 13-Apr-2027 04:28:31 GMT; path=/');
    expect(rescopeSetCookie('GPS=1; Path=/x; SameSite=Lax; Secure')).toBe(
      'GPS=1; Path=/x; SameSite=Lax',
    );
    expect(rescopeSetCookie('__Secure-YEC=; Domain=.youtube.com; Secure')).toBeNull();
    expect(rescopeSetCookie('rj_guest=evil; Path=/')).toBeNull();
  });

  it('sends YouTube the consent cookies plus the phone’s YouTube cookies, never the hub’s', () => {
    expect(upstreamCookie(undefined)).toBe('SOCS=CAI; CONSENT=YES+cb; PREF=f5=30000&hl=en&gl=US');
    const c = upstreamCookie('rj_guest=g1; YSC=abc; rj_admin=t; PREF=f6=8');
    expect(c).toContain('YSC=abc');
    expect(c).toContain('PREF=f6=8');
    expect(c).not.toContain('rj_');
  });

  it('rewrites redirect targets under /yt', () => {
    expect(rewriteLocation('https://m.youtube.com/results?q=1')).toBe('/yt/results?q=1');
    expect(rewriteLocation('https://www.youtube.com')).toBe('/yt/');
    expect(rewriteLocation('/feed')).toBe('/yt/feed');
    expect(rewriteLocation('https://accounts.google.com/x')).toBe('https://accounts.google.com/x');
  });
});

describe('/watch interception page', () => {
  it('reads the video ID from watch, shorts, live and embed paths', () => {
    expect(videoIdFromPath('/watch?v=OPf0YbXqDm0&list=RD1')).toBe('OPf0YbXqDm0');
    expect(videoIdFromPath('/watch?feature=x&v=OPf0YbXqDm0')).toBe('OPf0YbXqDm0');
    expect(videoIdFromPath('/shorts/OPf0YbXqDm0')).toBe('OPf0YbXqDm0');
    expect(videoIdFromPath('/watch?v=short')).toBeNull();
    expect(videoIdFromPath('/playlist?list=PL1')).toBeNull();
  });
  it('posts the pick to the parent and goes back', () => {
    const page = watchPage('OPf0YbXqDm0');
    expect(page).toContain('<meta name="rj-mirror-watch" content="OPf0YbXqDm0">');
    expect(page).toContain(`parent.postMessage({type:'rj-pick',videoId:id,title:''},'*')`);
    expect(page).toContain('var id="OPf0YbXqDm0"');
    expect(page).toContain('history.back()');
    expect(watchPage(null)).toContain('var id=null');
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills per second', () => {
    let now = 0;
    const rl = new RateLimiter(3, 2, () => now);
    expect([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(rl.take('b')).toBe(true);
    now += 500;
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
});

describe('mirror routes (fake upstream)', () => {
  let hub: TestHub;
  const seen: { url: string; init: RequestInit }[] = [];
  let down = false;
  const RESULTS =
    '<!doctype html><html><head><title>YouTube</title></head><body>' +
    '<ytm-compact-video-renderer><a href="/watch?v=OPf0YbXqDm0"><h3>Uptown Funk</h3></a></ytm-compact-video-renderer>' +
    '<script>var cfg={"u":"https:\\/\\/m.youtube.com\\/youtubei"};</script></body></html>';

  const fakeFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    seen.push({ url, init });
    if (down) throw new Error('offline');
    const u = new URL(url);
    if (u.pathname === '/results') {
      const headers = new Headers({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "require-trusted-types-for 'script'",
        'cross-origin-opener-policy': 'same-origin-allow-popups',
        'strict-transport-security': 'max-age=31536000',
        'report-to': '{}',
      });
      headers.append('set-cookie', 'YSC=abc; Domain=.youtube.com; Path=/; Secure; HttpOnly');
      headers.append('set-cookie', '__Secure-ROLLOUT_TOKEN=x; Domain=youtube.com; Secure');
      return new Response(RESULTS, { status: 200, headers });
    }
    if (u.pathname === '/youtubei/v1/search') {
      const body = init.body as string;
      return new Response(
        JSON.stringify({ echo: JSON.parse(body), url: 'https://www.youtube.com/x' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    if (u.pathname === '/old') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://m.youtube.com/new' },
      });
    }
    if (u.pathname.startsWith('/s/')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
  };

  beforeEach(async () => {
    seen.length = 0;
    down = false;
    hub = await makeHub({ fetch: fakeFetch as never });
  });
  afterEach(async () => {
    await hub.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    hub.app.inject({
      method: 'GET',
      url,
      remoteAddress: '192.168.1.50',
      headers: { host: '192.168.1.20:8080', ...headers },
    });

  it('serves the results page with the scripts injected and blocking headers stripped', async () => {
    const res = await get('/yt/results?search_query=funk', {
      cookie: 'rj_guest=g1; YSC=old',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    for (const h of [
      'x-frame-options',
      'content-security-policy',
      'cross-origin-opener-policy',
      'strict-transport-security',
      'report-to',
    ]) {
      expect(res.headers[h]).toBeUndefined();
    }
    expect(res.body).toContain(MIRROR_HEAD_SCRIPT);
    expect(res.body).toContain(MIRROR_PICK_SCRIPT);
    expect(res.body).toContain('<a href="/yt/watch?v=OPf0YbXqDm0">');
    expect(res.body).toContain('"u":"http:\\/\\/192.168.1.20:8080\\/yt\\/youtubei"');
    expect(res.headers['set-cookie']).toEqual(['YSC=abc; Path=/; HttpOnly']);

    const up = seen[0];
    expect(up?.url).toBe('https://m.youtube.com/results?search_query=funk');
    const h = up?.init.headers as Record<string, string>;
    expect(h['user-agent']).toBe(MIRROR_UA);
    expect(h['user-agent']).toMatch(/Mobile/);
    expect(h['accept-language']).toMatch(/^en-US/);
    expect(h['accept-encoding']).toBe('identity');
    expect(h.cookie).toContain('SOCS=CAI');
    expect(h.cookie).toContain('YSC=old');
    expect(h.cookie).not.toContain('rj_guest');
  });

  it('passes POST bodies through (gunzipped, our origin swapped back to YouTube’s)', async () => {
    const payload = JSON.stringify({ context: { url: 'http://192.168.1.20:8080/yt/results' } });
    const res = await hub.app.inject({
      method: 'POST',
      url: '/yt/youtubei/v1/search?prettyPrint=false',
      remoteAddress: '192.168.1.50',
      headers: {
        host: '192.168.1.20:8080',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-youtube-client-name': '2',
      },
      payload: gzipSync(payload),
    });
    expect(res.statusCode).toBe(200);
    // upstream got the plain body with YouTube's own origin…
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      context: { url: 'https://m.youtube.com/results' },
    });
    // …and the reply's YouTube URLs point back at the mirror
    expect(res.json().url).toBe('http://192.168.1.20:8080/yt/x');
    const h = seen[0]?.init.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/json');
    expect(h['x-youtube-client-name']).toBe('2');
    expect(h['content-encoding']).toBeUndefined();
    // the root alias reaches the same handler
    const alias = await hub.app.inject({
      method: 'POST',
      url: '/youtubei/v1/search',
      remoteAddress: '192.168.1.50',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(alias.statusCode).toBe(200);
  });

  it('answers watch pages, the service worker and telemetry itself', async () => {
    const watch = await get('/yt/watch?v=OPf0YbXqDm0&list=RD');
    expect(watch.statusCode).toBe(200);
    expect(watch.body).toContain('rj-pick');
    expect(watch.body).toContain('OPf0YbXqDm0');
    const shorts = await get('/yt/shorts/OPf0YbXqDm0');
    expect(shorts.body).toContain('"OPf0YbXqDm0"');
    const sw = await get('/yt/sw.js');
    expect(sw.headers['content-type']).toMatch(/javascript/);
    expect(sw.body).not.toMatch(/importScripts|addEventListener/);
    expect((await get('/yt/api/stats/qoe?x=1')).statusCode).toBe(204);
    expect((await get('/yt/generate_204')).statusCode).toBe(204);
    expect(seen).toHaveLength(0);
  });

  it('rewrites redirects, passes binaries through and redirects root navigations', async () => {
    const r = await get('/yt/old');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/yt/new');
    const bin = await get('/yt/s/img.png');
    expect(bin.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    await get('/yt/s/img.png');
    expect(seen.filter((s) => s.url.endsWith('/s/img.png'))).toHaveLength(1); // cached
    const root = await get('/results?search_query=a');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/yt/results?search_query=a');
  });

  it('shows an error page when YouTube is unreachable', async () => {
    down = true;
    const res = await get('/yt/results?search_query=');
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('<meta name="rj-mirror-error"');
  });

  it('rate-limits per source IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 65; i++) codes.push((await get('/yt/generate_204')).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(60);
    expect(codes.at(-1)).toBe(429);
    const other = await hub.app.inject({
      method: 'GET',
      url: '/yt/generate_204',
      remoteAddress: '192.168.1.51',
    });
    expect(other.statusCode).toBe(204);
  });

  it('answers 404 everywhere when the owner turns it off (search.mirror)', async () => {
    const { token } = await setup(hub.app);
    const patch = await hub.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${token}` },
      payload: { search: { mirror: false } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().search).toEqual({ source: 'page', mirror: false });
    expect((await get('/yt/results?search_query=')).statusCode).toBe(404);
    expect((await get('/yt/watch?v=OPf0YbXqDm0')).statusCode).toBe(404);
    expect((await get('/results')).statusCode).toBe(404);
    expect(seen).toHaveLength(0);
    const state = await hub.app.inject({ method: 'GET', url: '/api/session' });
    expect(state.json().flags.mirror).toBe(false);
  });
});
