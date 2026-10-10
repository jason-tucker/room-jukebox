/**
 * Unofficial search: reads the `ytInitialData` JSON embedded in YouTube's public results page.
 * This is not an API: it breaks YouTube's terms and can stop working whenever YouTube changes the
 * page. It is the owner-switchable fallback for when the Data API search budget is used up or no
 * key is configured (settings `search.unofficialFallback`). Everything here fails soft into
 * `UnofficialSearchError`, which the service maps to 502 `youtube-unavailable`.
 */
import type { VideoCard } from '@room-jukebox/shared';
import type { FetchLike } from './client.ts';

export const UNOFFICIAL_MAX_RESULTS = 50;
const RESULTS_URL = 'https://www.youtube.com/results';
/** `sp` filter: type = video. */
const VIDEOS_FILTER = 'EgIQAQ%3D%3D';
const TIMEOUT_MS = 10_000;
export const UNOFFICIAL_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Pre-answered consent, so EU visitors get results instead of the consent interstitial.
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

const LIVE_MESSAGE =
  "This is a live stream on YouTube; live videos never end, so they can't be queued.";

export type UnofficialFailure = 'network' | 'http' | 'no-data' | 'no-results';

export class UnofficialSearchError extends Error {
  readonly kind: UnofficialFailure;
  constructor(kind: UnofficialFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface UnofficialOptions {
  fetch: FetchLike;
}

/** The results-page URL for `q` (videos only). */
export function unofficialUrl(q: string): string {
  return `${RESULTS_URL}?search_query=${encodeURIComponent(q)}&sp=${encodeURIComponent(VIDEOS_FILTER)}`;
}

/** `h:mm:ss` / `mm:ss` / `ss` → seconds; null when it isn't a clock string. */
export function parseClock(text: string | undefined): number | null {
  if (text === undefined || !/^\d+(:\d{1,2}){0,2}$/.test(text.trim())) return null;
  return text
    .trim()
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * The JSON object literal that starts at the first `{` after `marker`, found by brace matching
 * (string-aware), so a `};` inside a title can't cut it short.
 */
function objectAfter(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

/** `ytInitialData` from the page, or null when absent or unparsable. */
export function extractInitialData(html: string): unknown {
  for (const marker of ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData =']) {
    const raw = objectAfter(html, marker);
    if (raw === null) continue;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function textOf(v: unknown): string | undefined {
  const o = obj(v);
  const simple = str(o.simpleText);
  if (simple !== undefined) return simple;
  const runs = arr(o.runs)
    .map((r) => str(obj(r).text) ?? '')
    .join('');
  return runs === '' ? undefined : runs;
}

function largestThumbnail(v: unknown): string | undefined {
  let best: { url: string; area: number } | undefined;
  for (const t of arr(obj(v).thumbnails)) {
    const url = str(obj(t).url);
    if (url === undefined) continue;
    const w = Number(obj(t).width) || 0;
    const h = Number(obj(t).height) || 0;
    if (best === undefined || w * h >= best.area) best = { url, area: w * h };
  }
  return best?.url;
}

/** Maps one `videoRenderer` to a card; null when it has no usable video ID. */
export function cardFromRenderer(r: Obj): VideoCard | null {
  const videoId = str(r.videoId);
  if (videoId === undefined || !/^[\w-]{11}$/.test(videoId)) return null;
  const length = textOf(r.lengthText);
  const card: VideoCard = {
    videoId,
    title: textOf(r.title) ?? videoId,
    channelTitle: str(obj(arr(obj(r.ownerText).runs)[0]).text) ?? '',
    thumbnail: largestThumbnail(r.thumbnail) ?? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    durationSec: parseClock(length),
    playable: true,
  };
  if (length === undefined) {
    // Live streams (and upcoming premieres) have no length.
    card.durationSec = null;
    card.playable = false;
    card.reason = 'live';
    card.source = 'youtube';
    card.message = LIVE_MESSAGE;
  }
  return card;
}

/**
 * Video cards in YouTube's order from parsed `ytInitialData`. Only `videoRenderer` items count;
 * shelves (shorts), ads, playlists and channels are skipped. Duplicate IDs keep the first.
 */
export function cardsFromInitialData(data: unknown): VideoCard[] {
  const sections = arr(
    obj(
      obj(obj(obj(obj(data).contents).twoColumnSearchResultsRenderer).primaryContents)
        .sectionListRenderer,
    ).contents,
  );
  const out: VideoCard[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const item of arr(obj(obj(section).itemSectionRenderer).contents)) {
      const renderer = obj(item).videoRenderer;
      if (!isObj(renderer)) continue;
      const card = cardFromRenderer(renderer);
      if (card === null || seen.has(card.videoId)) continue;
      seen.add(card.videoId);
      out.push(card);
      if (out.length >= UNOFFICIAL_MAX_RESULTS) return out;
    }
  }
  return out;
}

/** Searches YouTube's public results page. Throws `UnofficialSearchError` on any failure. */
export async function searchUnofficial(
  q: string,
  options: UnofficialOptions,
): Promise<VideoCard[]> {
  let res: Response;
  try {
    res = await options.fetch(unofficialUrl(q.trim()), {
      headers: { ...UNOFFICIAL_HEADERS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new UnofficialSearchError('network', `YouTube is unreachable (${String(err)})`);
  }
  if (!res.ok) throw new UnofficialSearchError('http', `YouTube returned ${res.status}`);
  const html = await res.text().catch(() => '');
  const data = extractInitialData(html);
  if (data === null) {
    throw new UnofficialSearchError('no-data', 'No search data on the YouTube results page');
  }
  const cards = cardsFromInitialData(data);
  if (cards.length === 0) {
    throw new UnofficialSearchError('no-results', 'No videos on the YouTube results page');
  }
  return cards;
}
