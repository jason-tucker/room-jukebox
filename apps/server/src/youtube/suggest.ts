/**
 * Typing suggestions from YouTube's public suggest service (the list under youtube.com's search
 * box). Not an API and not covered by the YouTube API terms; no quota. Fails soft: any error is
 * an empty list. Answers are cached in memory for 10 minutes per normalised prefix, and each
 * source IP may ask once per 300 ms (extras are dropped).
 */
import type { FetchLike } from './client.ts';
import { UNOFFICIAL_HEADERS } from './unofficial.ts';

export const SUGGEST_MAX = 10;
export const SUGGEST_CACHE_TTL_MS = 10 * 60 * 1000;
export const SUGGEST_MIN_INTERVAL_MS = 300;
const SUGGEST_URL = 'https://suggestqueries-clients6.youtube.com/complete/search';
const TIMEOUT_MS = 3000;
const MAX_CACHE = 2000;
const MAX_TRACKED_IPS = 1000;

/** The suggest URL for `q` (`client=youtube` answers JSONP: `window.google.ac.h([...])`). */
export function suggestUrl(q: string): string {
  return `${SUGGEST_URL}?client=youtube&ds=yt&hl=en&q=${encodeURIComponent(q)}`;
}

/** Lower-cased, whitespace-collapsed, trimmed (the cache key). */
export const normalisePrefix = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Suggestions from a suggest response: JSONP (`window.google.ac.h(["q",[["a",0,[512]],…],{…}])`)
 * or plain JSON (`["q",["a","b"]]`). Takes the second element's items (a string, or an array
 * whose first item is the string). Throws on anything unparsable.
 */
export function parseSuggestions(body: string): string[] {
  let text = body.trim();
  if (!text.startsWith('[')) {
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close <= open) throw new Error('not a suggest response');
    text = text.slice(open + 1, close);
  }
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('no suggestion list');
  const out: string[] = [];
  for (const item of data[1] as unknown[]) {
    const s = typeof item === 'string' ? item : Array.isArray(item) ? item[0] : undefined;
    if (typeof s !== 'string' || s.trim() === '' || out.includes(s)) continue;
    out.push(s);
    if (out.length >= SUGGEST_MAX) break;
  }
  return out;
}

export interface SuggestOptions {
  fetch: FetchLike;
  now: () => number;
}

export class SuggestService {
  #fetch: FetchLike;
  #now: () => number;
  #cache = new Map<string, { at: number; suggestions: string[] }>();
  #lastByIp = new Map<string, number>();

  constructor(options: SuggestOptions) {
    this.#fetch = options.fetch;
    this.#now = options.now;
  }

  /** Suggestions for `q`; null when `ip` asked less than 300 ms ago (the caller answers 204). */
  async suggest(q: string, ip: string): Promise<string[] | null> {
    const now = this.#now();
    const last = this.#lastByIp.get(ip);
    if (last !== undefined && now - last < SUGGEST_MIN_INTERVAL_MS) return null;
    this.#lastByIp.delete(ip);
    this.#lastByIp.set(ip, now);
    if (this.#lastByIp.size > MAX_TRACKED_IPS) {
      const oldest = this.#lastByIp.keys().next().value;
      if (oldest !== undefined) this.#lastByIp.delete(oldest);
    }

    const key = normalisePrefix(q);
    if (key === '') return [];
    const hit = this.#cache.get(key);
    if (hit !== undefined && now - hit.at < SUGGEST_CACHE_TTL_MS) return hit.suggestions;

    let suggestions: string[];
    try {
      const res = await this.#fetch(suggestUrl(key), {
        headers: { ...UNOFFICIAL_HEADERS },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return [];
      suggestions = parseSuggestions(await res.text());
    } catch {
      return [];
    }
    this.#cache.delete(key);
    this.#cache.set(key, { at: now, suggestions });
    if (this.#cache.size > MAX_CACHE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return suggestions;
  }
}
