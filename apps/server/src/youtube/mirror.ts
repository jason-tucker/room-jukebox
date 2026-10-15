/**
 * YouTube mirror: serves YouTube's mobile site through the hub's own origin under `/yt/*`, so the
 * guest page can embed it in an iframe (youtube.com refuses framing) and catch taps on videos.
 *
 * Like the unofficial search this is not an API: it breaks YouTube's terms and can stop working
 * whenever YouTube changes its site. The owner can turn it off (settings `search.mirror`), and
 * then every mirror route answers 404.
 *
 * What it does to each exchange:
 *   - request: forwards to `https://m.youtube.com<path>` (a few paths to www), with a mobile Chrome
 *     UA, `Accept-Language: en-US`, pre-answered consent cookies, the phone's own YouTube cookies
 *     (never the hub's), the body and `Content-Type`, and `Accept-Encoding: identity`;
 *   - response headers: an allowlist (Content-Type, Cache-Control, …) so framing/CSP/COOP/HSTS/
 *     reporting headers never reach the phone; `Set-Cookie` re-scoped to the hub origin;
 *     redirects rewritten to `/yt`;
 *   - text bodies: YouTube hosts → `<origin>/yt` (plain, protocol-relative and escaped forms);
 *     HTML also gets root-relative attributes moved under `/yt/`, `<base>` rewritten, a
 *     no-referrer meta and the two injected scripts (mirror-scripts.ts);
 *   - telemetry answers 204 locally; `/sw.js` is an empty script; `/watch`, `/shorts/…` answer a
 *     tiny page that posts the pick to the guest page and goes back (video never plays).
 */
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sourceIp } from '../auth/gate.ts';
import { ADMIN_COOKIE } from '../auth/admin.ts';
import { GUEST_COOKIE } from '../auth/guest-cookie.ts';
import type { FetchLike } from './client.ts';
import { MIRROR_HEAD_SCRIPT, MIRROR_PICK_SCRIPT } from './mirror-scripts.ts';

export const MIRROR_PREFIX = '/yt';
export const MIRROR_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
/** Pre-answered consent (EU interstitial) and autoplay off (`f5=30000`), English/US. */
export const MIRROR_BASE_COOKIES: Readonly<Record<string, string>> = {
  SOCS: 'CAI',
  CONSENT: 'YES+cb',
  PREF: 'f5=30000&hl=en&gl=US',
};
const M_HOST = 'https://m.youtube.com';
const WWW_HOST = 'https://www.youtube.com';
/**
 * Other hosts YouTube's page calls with CORS (which fails from the hub origin), mounted under
 * `/yt/<prefix>`: typing suggestions and the icon SVGs on www.gstatic.com.
 */
export const SIDE_HOSTS: ReadonlyArray<{ prefix: string; host: string; only?: string }> = [
  { prefix: '/_suggest', host: 'https://suggestqueries-clients6.youtube.com' },
  { prefix: '/_gstatic', host: 'https://www.gstatic.com', only: '/youtube/img/' },
];
/** Paths only www.youtube.com serves reliably. Everything else goes to m.youtube.com. */
const WWW_PATHS = [/^\/yts\//, /^\/s\/player\//, /^\/s\/desktop\//];
const TIMEOUT_MS = 15_000;
/** Telemetry, ads pings and the player (no previews play): answered 204 here, never forwarded. */
const LOCAL_204 = [
  /^\/youtubei\/v1\/log_event/,
  /^\/youtubei\/v1\/att\//,
  /^\/api\/stats\//,
  /^\/ptracking/,
  /^\/generate_204/,
  /^\/csi_204/,
  /^\/pagead\//,
  /^\/web-reports/,
  /^\/error_204/,
  /^\/youtubei\/v1\/player/,
];
/** Paths that would open a video: the mirror answers them itself (a pick, then back). */
const VIDEO_PATH = /^\/(watch|shorts\/|playlist|live\/|embed\/)/;
/** Response headers passed to the phone; everything else (XFO, CSP, COOP, HSTS, …) is dropped. */
export const KEPT_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'expires',
  'last-modified',
  'etag',
  'content-disposition',
  'x-content-type-options',
];
/** Request headers forwarded upstream (besides the ones the mirror sets itself). */
const FORWARDED_REQUEST_HEADERS =
  /^(content-type|accept|x-youtube-[\w-]+|x-goog-[\w-]+|x-origin)$/i;
/** Hub cookies never leave the hub. */
const HUB_COOKIES = new Set([GUEST_COOKIE, ADMIN_COOKIE]);

/** The upstream URL for a mirrored path (`/results?…`, `/_suggest/complete/search?…`). */
export function upstreamUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  for (const side of SIDE_HOSTS) {
    if (p.startsWith(`${side.prefix}/`)) return side.host + p.slice(side.prefix.length);
  }
  const host = WWW_PATHS.some((re) => re.test(p)) ? WWW_HOST : M_HOST;
  return `${host}${p}`;
}

/** One `/` in any of the escapings found in YouTube's HTML, JS and JSON. */
const SL = String.raw`(?:\/|\\\/|\\x2F|\\u002F)`;
/**
 * Scheme (optional) + `//` (escaped or not; the first slash captured to copy its escaping) + a
 * mirrored host (captured), not followed by more hostname.
 */
const HOST_RE = new RegExp(
  String.raw`(?:https?:)?(\/|\\\/|\\x2F|\\u002F)${SL}(` +
    String.raw`(?:www\.|m\.)?youtube\.com|suggestqueries-clients6\.youtube\.com|www\.gstatic\.com(?=${SL}youtube${SL}img${SL})` +
    String.raw`)(?![\w.-])`,
  'gi',
);

function prefixFor(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith('suggestqueries')) return '/_suggest';
  if (h === 'www.gstatic.com') return '/_gstatic';
  return '';
}

/**
 * YouTube web hosts (`m.`, `www.`, bare) → `<origin>/yt`, the suggest host → `<origin>/yt/_suggest`
 * and www.gstatic.com's YouTube icons → `<origin>/yt/_gstatic`, keeping the escaping of the match
 * (`https:\/\/www.youtube.com` → `http:\/\/hub:8080\/yt`). Image/video/font hosts (`i.ytimg.com`,
 * `yt3.ggpht.com`, `*.googlevideo.com`, `fonts.gstatic.com`) and other youtube.com subdomains
 * are left alone.
 */
export function rewriteText(text: string, origin: string): string {
  return text.replace(HOST_RE, (_m, slash: string, host: string) => {
    const to = `${origin}${MIRROR_PREFIX}${prefixFor(host)}`;
    return slash === '/' ? to : to.replaceAll('/', slash);
  });
}

/** Text bodies the mirror rewrites. */
export function isRewritable(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^(text\/html|text\/css|text\/javascript|application\/(x-)?javascript|application\/json|text\/plain)/i.test(
    contentType,
  );
}

const scriptTag = (js: string) => `<script>${js}</script>`;

/**
 * HTML on top of `rewriteText`: root-relative `src`/`href`/`action`/`poster` → `/yt/…`, `<base>`
 * pointed at the mirror, a no-referrer meta plus the head script first in `<head>`, and the pick
 * script before `</body>`.
 */
export function rewriteHtml(html: string, origin: string): string {
  let out = rewriteText(html, origin);
  out = out.replace(
    /(\s(?:src|href|action|poster)\s*=\s*["'])\/(?!\/|yt\/)/gi,
    `$1${MIRROR_PREFIX}/`,
  );
  out = out.replace(/<base\b[^>]*>/gi, `<base href="${origin}${MIRROR_PREFIX}/">`);
  const head = `<meta name="referrer" content="no-referrer">${scriptTag(MIRROR_HEAD_SCRIPT)}`;
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  else out = head + out;
  const tail = scriptTag(MIRROR_PICK_SCRIPT);
  const close = out.lastIndexOf('</body>');
  out = close >= 0 ? `${out.slice(0, close)}${tail}${out.slice(close)}` : out + tail;
  return out;
}

/** The kept response headers (lower-case names). */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * One upstream `Set-Cookie` re-scoped to the hub: `Domain`, `Secure`, `Partitioned` and
 * `SameSite=None` dropped (the LAN is plain HTTP, where browsers reject those), `Path` and the
 * rest kept. `__Secure-`/`__Host-` cookies need HTTPS and hub cookie names are reserved: null.
 */
export function rescopeSetCookie(value: string): string | null {
  const parts = value.split(';').map((p) => p.trim());
  const first = parts.shift() ?? '';
  const name = first.split('=')[0]?.trim() ?? '';
  if (name === '' || /^__(Secure|Host)-/i.test(name) || HUB_COOKIES.has(name)) return null;
  const kept = parts.filter((p) => {
    const key = (p.split('=')[0] ?? '').trim().toLowerCase();
    if (key === 'domain' || key === 'secure' || key === 'partitioned') return false;
    if (key === 'samesite' && /none/i.test(p)) return false;
    return p !== '';
  });
  return [first, ...kept].join('; ');
}

/** The `Cookie` header for YouTube: consent defaults overlaid with the phone's own cookies. */
export function upstreamCookie(phoneCookie: string | undefined): string {
  const jar = new Map(Object.entries(MIRROR_BASE_COOKIES));
  for (const part of (phoneCookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name === '' || HUB_COOKIES.has(name)) continue;
    jar.set(name, part.slice(at + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A YouTube redirect target as a mirror URL (`https://m.youtube.com/x` → `/yt/x`). */
export function rewriteLocation(location: string): string {
  const m = /^(?:https?:)?\/\/(?:www\.|m\.)?youtube\.com(?![\w.-])(.*)$/i.exec(location);
  if (m) return `${MIRROR_PREFIX}${m[1] || '/'}`;
  if (location.startsWith('/') && !location.startsWith('//')) return `${MIRROR_PREFIX}${location}`;
  return location;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The video ID a `/watch`/`/shorts/`/`/live/`/`/embed/` path names, or null. */
export function videoIdFromPath(path: string): string | null {
  const m =
    /^\/watch\?(?:.*&)?v=([\w-]{11})(?![\w-])/.exec(path) ??
    /^\/(?:shorts|live|embed)\/([\w-]{11})(?![\w-])/.exec(path);
  return m?.[1] ?? null;
}

/**
 * The page the mirror serves instead of a video: posts the pick to the guest page and goes back
 * to the results (or to a blank search when there is no history).
 */
export function watchPage(videoId: string | null): string {
  const id = videoId === null ? 'null' : JSON.stringify(videoId);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="rj-mirror-watch" content="${escapeHtml(videoId ?? '')}"><meta name="referrer" content="no-referrer"></head><body><script>(function(){var id=${id};if(id){try{parent.postMessage({type:'rj-pick',videoId:id,title:''},'*')}catch(e){}}if(history.length>1)history.back();else location.replace('${MIRROR_PREFIX}/results?search_query=')})();</script></body></html>`;
}

/** The page shown when YouTube can't be reached (the guest page looks for the meta). */
export function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="rj-mirror-error" content="${escapeHtml(message)}"><meta name="viewport" content="width=device-width"></head><body style="font:16px system-ui;padding:24px">YouTube didn't load. ${escapeHtml(message)}</body></html>`;
}

/** Token bucket per source IP. */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #capacity: number;
  readonly #perSec: number;
  readonly #now: () => number;
  constructor(capacity: number, perSec: number, now: () => number) {
    this.#capacity = capacity;
    this.#perSec = perSec;
    this.#now = now;
  }
  take(key: string): boolean {
    const now = this.#now();
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    b.tokens = Math.min(this.#capacity, b.tokens + ((now - b.at) / 1000) * this.#perSec);
    b.at = now;
    if (this.#buckets.size > 1000) this.#buckets.clear();
    this.#buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

interface Cached {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Small LRU (by bytes) for YouTube's versioned static files (`/s/…`, `/static/…`). */
class StaticCache {
  #map = new Map<string, Cached>();
  #bytes = 0;
  readonly #max: number;
  constructor(maxBytes: number) {
    this.#max = maxBytes;
  }
  get(key: string): Cached | undefined {
    const hit = this.#map.get(key);
    if (hit) {
      this.#map.delete(key);
      this.#map.set(key, hit);
    }
    return hit;
  }
  set(key: string, value: Cached): void {
    if (value.body.length > this.#max / 4) return;
    this.#map.set(key, value);
    this.#bytes += value.body.length;
    for (const [k, v] of this.#map) {
      if (this.#bytes <= this.#max) break;
      this.#map.delete(k);
      this.#bytes -= v.body.length;
    }
  }
}

const CACHEABLE = /^\/(s|static)\//;

export interface MirrorOptions {
  fetch: FetchLike;
  /** Owner setting `search.mirror`; false → every mirror route answers 404. */
  enabled: () => boolean;
  now?: () => number;
  /** Burst per source IP (default 60) and sustained requests per second (default 30). */
  burst?: number;
  perSec?: number;
}

/**
 * Mounts the mirror: `/yt` and `/yt/*`, plus root aliases for what YouTube's code may still ask
 * of the hub root (`/youtubei/*`, `/s/*`, `/sw.js`) and navigations it may still make there
 * (`/results`, `/watch`, `/shorts/*` → redirected under `/yt`). No auth (guests use it), rate
 * limited per source IP.
 */
export async function registerMirror(app: FastifyInstance, opts: MirrorOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter(opts.burst ?? 60, opts.perSec ?? 30, now);
  const cache = new StaticCache(48 * 1024 * 1024);

  await app.register(async (scope) => {
    // Bodies pass through untouched (YouTube posts JSON and protobuf).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    const handle = async (request: FastifyRequest, reply: FastifyReply, path: string) => {
      if (!opts.enabled()) {
        return reply.code(404).send({
          error: { code: 'not-found', message: 'Embedded YouTube browsing is turned off' },
        });
      }
      if (!limiter.take(sourceIp(request))) {
        return reply.code(429).header('retry-after', '1').send('Too many requests');
      }
      return proxy(request, reply, path);
    };

    const proxy = async (request: FastifyRequest, reply: FastifyReply, path: string) => {
      const pathname = path.split('?')[0] ?? '/';
      if (LOCAL_204.some((re) => re.test(pathname))) return reply.code(204).send();
      if (pathname === '/sw.js' || pathname === '/serviceworker.js') {
        return reply
          .type('application/javascript; charset=utf-8')
          .header('cache-control', 'no-store')
          .send('// service workers are off in the jukebox mirror\n');
      }
      if (VIDEO_PATH.test(path)) {
        return reply
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(watchPage(videoIdFromPath(path)));
      }

      const origin = `${request.protocol}://${request.headers.host ?? 'localhost'}`;
      const cacheKey = `${origin} ${path}`;
      const cacheable = request.method === 'GET' && CACHEABLE.test(pathname);
      if (cacheable) {
        const hit = cache.get(cacheKey);
        if (hit) return reply.code(hit.status).headers(hit.headers).send(hit.body);
      }

      const headers: Record<string, string> = {
        'user-agent': MIRROR_UA,
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'identity',
        cookie: upstreamCookie(request.headers.cookie),
        origin: M_HOST,
        referer: `${M_HOST}/`,
      };
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string' && FORWARDED_REQUEST_HEADERS.test(k)) headers[k] = v;
      }
      if (headers['x-origin']) headers['x-origin'] = M_HOST;
      let body: Buffer | string | undefined =
        request.method === 'POST' && Buffer.isBuffer(request.body) ? request.body : undefined;
      if (body !== undefined && /gzip/i.test(String(request.headers['content-encoding'] ?? ''))) {
        // YouTube gzips its API calls; send them on plain (and rewritable).
        try {
          body = gunzipSync(body);
        } catch {
          headers['content-encoding'] = 'gzip';
        }
      }
      if (
        Buffer.isBuffer(body) &&
        !headers['content-encoding'] &&
        isRewritable(headers['content-type'] ?? null)
      ) {
        // The client context carries our URLs; show YouTube its own.
        body = body
          .toString('utf8')
          .replaceAll(`${origin}${MIRROR_PREFIX}`, M_HOST)
          .replaceAll(origin, M_HOST);
      }

      let res: Response;
      try {
        res = await opts.fetch(upstreamUrl(path), {
          method: request.method === 'HEAD' ? 'GET' : request.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        request.log.warn({ err, path }, 'yt mirror: upstream failed');
        return reply
          .code(502)
          .type('text/html; charset=utf-8')
          .send(errorPage('YouTube is unreachable from the hub.'));
      }

      const out = filterResponseHeaders(res.headers);
      const location = res.headers.get('location');
      if (location !== null) out.location = rewriteLocation(location);
      const cookies = res.headers
        .getSetCookie()
        .map(rescopeSetCookie)
        .filter((c): c is string => c !== null);
      if (cookies.length > 0) void reply.header('set-cookie', cookies);
      void reply.code(res.status).headers(out);

      const type = res.headers.get('content-type');
      let payload: Buffer;
      if (isRewritable(type)) {
        const text = await res.text();
        payload = Buffer.from(
          /^text\/html/i.test(type ?? '') ? rewriteHtml(text, origin) : rewriteText(text, origin),
        );
      } else {
        payload = Buffer.from(await res.arrayBuffer());
      }
      if (cacheable && res.status === 200 && cookies.length === 0) {
        cache.set(cacheKey, { status: 200, headers: out, body: payload });
      }
      return reply.send(payload);
    };

    const methods = ['GET', 'POST'] as const;
    scope.route({
      method: [...methods],
      url: `${MIRROR_PREFIX}/*`,
      handler: (request, reply) =>
        handle(request, reply, request.url.slice(MIRROR_PREFIX.length) || '/'),
    });
    scope.get(MIRROR_PREFIX, (request, reply) => reply.redirect(`${MIRROR_PREFIX}/`));
    // Root aliases: calls YouTube's code still aims at the hub root.
    for (const url of ['/youtubei/*', '/s/*', '/sw.js']) {
      scope.route({
        method: [...methods],
        url,
        handler: (request, reply) => handle(request, reply, request.url),
      });
    }
    // Full navigations YouTube may still make at the root: back under /yt.
    for (const url of ['/results', '/watch', '/shorts/*']) {
      scope.get(url, (request, reply) => {
        if (!opts.enabled()) return reply.code(404).send();
        return reply.redirect(`${MIRROR_PREFIX}${request.url}`);
      });
    }
  });
}
