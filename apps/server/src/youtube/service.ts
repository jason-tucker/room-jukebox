/**
 * YouTube features on top of the API client: video lookup into the `videos` table, pre-screen,
 * link resolve, submit-only search (YouTube's results page by default, or the Data API with its
 * daily budget when the owner picks it) with the 24 h ID cache, playlist import, and the quota
 * log.
 */
import { randomUUID } from 'node:crypto';
import {
  checkSearchBudget,
  evaluateVideo,
  recordSearch,
  remainingSearches,
  SEARCH_LOW_WARNING,
} from '@room-jukebox/core';
import type {
  PrescreenResult,
  SearchActor,
  SearchRejection,
  SearchUsage,
  VideoMeta,
} from '@room-jukebox/core';
import type {
  GuestState,
  PlaylistInfo,
  ResolveReply,
  SearchProvider,
  SearchReply,
  SearchesReply,
  VideoCard,
} from '@room-jukebox/shared';
import type { Repos, VideoRow } from '../db/repo.ts';
import { HttpError } from '../errors.ts';
import type { SettingsService } from '../settings.ts';
import { toPlaylistInfo } from '../settings.ts';
import type { VideoResource, YouTubeApi } from './client.ts';
import { pickThumbnail, YouTubeHttpError } from './client.ts';
import { extractPlaylistId, parseIsoDuration } from './ids.ts';
import { UnofficialSearchError } from './unofficial.ts';

/** M1 keeps search ID lists and video metadata for 24 h. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYLIST_PAGES = 20;
const PACIFIC = 'America/Los_Angeles';

/**
 * Budget rejections the results-page fallback (source `api-first`) may answer. The per-guest/per-IP `interval`
 * cooldown is not one of them: it still answers 429.
 */
const EXHAUSTED: ReadonlySet<SearchRejection> = new Set<SearchRejection>([
  'daily-quota',
  'owner-reserve',
  'public-daily',
  'guest-daily',
  'ip-daily',
]);

const UNAVAILABLE = 'YouTube search is not answering right now.';
const seconds = (n: number): string => `${n} second${n === 1 ? '' : 's'}`;

/** Lower-cased, whitespace-collapsed, trimmed. */
export const normaliseQuery = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim();

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: PACIFIC,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** YouTube's quota day (`YYYY-MM-DD` in Pacific time). */
export const pacificDay = (now: number): string => dayFormat.format(new Date(now));

/** ms of the next midnight Pacific (when YouTube's quota resets). */
export function nextPacificMidnight(now: number): number {
  const [y, m, d] = pacificDay(now).split('-').map(Number) as [number, number, number];
  for (const offsetHours of [7, 8, 6, 9]) {
    const t = Date.UTC(y, m - 1, d + 1, offsetHours);
    if (timeFormat.format(new Date(t)) === '00:00') return t;
  }
  return Date.UTC(y, m - 1, d + 1, 8);
}

export function metaOf(row: VideoRow | null): VideoMeta | null {
  if (row === null || row.missing) return null;
  const meta: VideoMeta = {};
  if (row.embeddable !== undefined) meta.embeddable = row.embeddable;
  if (row.privacyStatus !== undefined) meta.privacyStatus = row.privacyStatus;
  if (row.ytRating !== undefined) meta.ytRating = row.ytRating;
  if (row.liveBroadcastContent !== undefined) meta.liveBroadcastContent = row.liveBroadcastContent;
  if (row.regionRestriction !== undefined) meta.regionRestriction = row.regionRestriction;
  if (row.durationSec !== undefined) meta.durationSec = row.durationSec;
  if (row.madeForKids !== undefined) meta.madeForKids = row.madeForKids;
  return meta;
}

/** Rows written from `videos.list` (not only an oEmbed title). */
const isApiRow = (row: VideoRow): boolean => row.missing || row.embeddable !== undefined;

export function videoRowFromResource(r: VideoResource, now: number): VideoRow {
  const row: VideoRow = {
    videoId: r.id,
    title: r.snippet?.title ?? r.id,
    missing: false,
    refreshedAt: now,
    durationSec: parseIsoDuration(r.contentDetails?.duration),
  };
  if (r.snippet?.channelTitle !== undefined) row.channelTitle = r.snippet.channelTitle;
  const thumb = pickThumbnail(r.snippet?.thumbnails, r.id);
  if (thumb !== undefined) row.thumbnail = thumb;
  if (r.status?.embeddable !== undefined) row.embeddable = r.status.embeddable;
  else row.embeddable = true;
  if (r.status?.privacyStatus !== undefined) row.privacyStatus = r.status.privacyStatus;
  if (r.status?.madeForKids !== undefined) row.madeForKids = r.status.madeForKids;
  const rating = r.contentDetails?.contentRating?.ytRating;
  if (rating !== undefined) row.ytRating = rating;
  if (r.snippet?.liveBroadcastContent !== undefined)
    row.liveBroadcastContent = r.snippet.liveBroadcastContent;
  const region = r.contentDetails?.regionRestriction;
  if (region !== undefined) {
    row.regionRestriction = {
      ...(region.allowed ? { allowed: region.allowed } : {}),
      ...(region.blocked ? { blocked: region.blocked } : {}),
    };
  }
  return row;
}

/** A results-page card as a (non-API) video row, so the shared pre-screen applies to it. */
function rowFromCard(c: VideoCard, at: number): VideoRow {
  const row: VideoRow = {
    videoId: c.videoId,
    title: c.title,
    channelTitle: c.channelTitle,
    thumbnail: c.thumbnail,
    missing: false,
    refreshedAt: at,
  };
  if (c.durationSec != null) row.durationSec = c.durationSec;
  if (c.reason === 'live') row.liveBroadcastContent = 'live';
  return row;
}

export interface YouTubeServiceOptions {
  repos: Repos;
  settings: SettingsService;
  api: YouTubeApi;
  /** Results-page search (see `unofficial.ts`); throws `UnofficialSearchError`. */
  unofficial: (q: string) => Promise<VideoCard[]>;
  now: () => number;
}

export class YouTubeService {
  #repos: Repos;
  #settings: SettingsService;
  #api: YouTubeApi;
  #unofficial: (q: string) => Promise<VideoCard[]>;
  #now: () => number;

  constructor(options: YouTubeServiceOptions) {
    this.#repos = options.repos;
    this.#settings = options.settings;
    this.#api = options.api;
    this.#unofficial = options.unofficial;
    this.#now = options.now;
  }

  hasKey(): boolean {
    return this.#settings.apiKey() !== null;
  }

  prescreen(row: VideoRow | null): PrescreenResult {
    const d = this.#settings.data();
    return evaluateVideo(metaOf(row), {
      maxDurationSec: d.limits.maxDurationSec,
      country: d.country,
    });
  }

  /**
   * Metadata for `ids` from the `videos` table, refreshing rows older than 24 h (or written from
   * oEmbed only) through `videos.list` in batches of 50 when a key exists. IDs absent from the
   * response are stored as `missing`. Returns what is known (stale rows when YouTube fails).
   */
  async lookupVideos(ids: readonly string[]): Promise<Map<string, VideoRow>> {
    const now = this.#now();
    const known = this.#repos.videos.getMany(ids);
    const key = this.#settings.apiKey();
    if (key === null) return known;
    const stale = [...new Set(ids)].filter((id) => {
      const row = known.get(id);
      return row === undefined || !isApiRow(row) || now - row.refreshedAt >= CACHE_TTL_MS;
    });
    for (let i = 0; i < stale.length; i += 50) {
      const batch = stale.slice(i, i + 50);
      let resources: VideoResource[];
      try {
        resources = await this.#api.videos(key, batch);
      } catch {
        break;
      }
      const found = new Set<string>();
      for (const r of resources) {
        const row = videoRowFromResource(r, now);
        this.#repos.videos.upsert(row);
        known.set(row.videoId, row);
        found.add(row.videoId);
      }
      for (const id of batch) {
        if (found.has(id)) continue;
        const row: VideoRow = {
          videoId: id,
          title: known.get(id)?.title ?? id,
          missing: true,
          refreshedAt: now,
        };
        this.#repos.videos.upsert(row);
        known.set(id, row);
      }
    }
    return known;
  }

  /**
   * Link resolve and the request pre-screen: `videos.list` when a key exists, else keyless oEmbed
   * (404 → not found, 401/403 → not embeddable; unreachable → assumed playable).
   */
  async resolve(videoId: string): Promise<ResolveReply> {
    if (this.hasKey()) {
      const row = (await this.lookupVideos([videoId])).get(videoId) ?? null;
      if (row !== null && isApiRow(row)) return this.#replyFromRow(videoId, row);
    }
    const cached = this.#repos.videos.get(videoId);
    const o = await this.#api.oembed(`https://www.youtube.com/watch?v=${videoId}`);
    if (o.ok) {
      const row: VideoRow = {
        ...(cached ?? { missing: false }),
        videoId,
        title: o.data.title,
        refreshedAt: cached?.refreshedAt ?? this.#now(),
        missing: false,
      };
      if (o.data.author_name !== undefined) row.channelTitle = o.data.author_name;
      if (o.data.thumbnail_url !== undefined) row.thumbnail = o.data.thumbnail_url;
      if (cached === null) this.#repos.videos.upsert(row);
      return this.#replyFromRow(videoId, row);
    }
    if (o.status === 404 || o.status === 400) {
      return this.#replyFromRow(videoId, {
        videoId,
        title: videoId,
        missing: true,
        refreshedAt: 0,
      });
    }
    if (o.status === 401 || o.status === 403) {
      return this.#replyFromRow(videoId, {
        videoId,
        title: cached?.title ?? videoId,
        embeddable: false,
        missing: false,
        refreshedAt: 0,
      });
    }
    // YouTube unreachable: allow; play-time errors catch anything wrong.
    return this.#replyFromRow(
      videoId,
      cached ?? { videoId, title: 'YouTube video', missing: false, refreshedAt: 0 },
    );
  }

  #replyFromRow(videoId: string, row: VideoRow): ResolveReply {
    const screen = this.prescreen(row.missing ? null : row);
    const reply: ResolveReply = {
      videoId,
      title: row.title,
      durationSec: row.durationSec ?? null,
      playable: screen.playable,
    };
    if (row.thumbnail !== undefined) reply.thumbnail = row.thumbnail;
    else reply.thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    if (row.channelTitle !== undefined) reply.channelTitle = row.channelTitle;
    if (!screen.playable) {
      reply.reason = screen.reason;
      reply.source = screen.source;
      reply.message = screen.message;
    }
    return reply;
  }

  // -------------------------------------------------------------------------------------------
  // Search

  usage(now: number = this.#now()): SearchUsage {
    return this.#repos.searchUsage.get(pacificDay(now));
  }

  searchesReply(): SearchesReply {
    const now = this.#now();
    const limits = this.#settings.data().limits;
    const left = remainingSearches(this.usage(now), limits);
    return {
      guests: left.guests,
      owner: left.owner,
      resetsAt: nextPacificMidnight(now),
      dailyTotal: limits.search.dailyTotal,
    };
  }

  /** Official searches this guest may still make today (null without a key). */
  remainingFor(guestId: string | null): number | null {
    if (!this.hasKey()) return null;
    const limits = this.#settings.data().limits;
    const usage = this.usage();
    const global = remainingSearches(usage, limits).guests;
    if (guestId === null) return global;
    const mine = Math.max(0, limits.search.perGuestPerDay - (usage.byGuest[guestId] ?? 0));
    return Math.min(global, mine);
  }

  /**
   * `GuestState.search`. Source `page`: always the results page. `api-first`: the official API
   * while it can still serve this guest, then the results page. `api-only`: the API, else off.
   */
  searchState(guestId: string | null): GuestState['search'] {
    const source = this.#settings.searchSource();
    if (source === 'page') {
      return { enabled: true, remaining: null, low: false, provider: 'unofficial' };
    }
    const remaining = this.remainingFor(guestId);
    if (remaining !== null && remaining > 0) {
      return {
        enabled: true,
        remaining,
        low: remaining <= SEARCH_LOW_WARNING,
        provider: 'youtube-api',
      };
    }
    if (source === 'api-first') {
      return { enabled: true, remaining: null, low: false, provider: 'unofficial' };
    }
    return {
      enabled: false,
      remaining,
      low: remaining !== null,
      ...(remaining !== null ? { provider: 'youtube-api' as const } : {}),
    };
  }

  /**
   * Submit-only search. Cache hits (either provider) are free. Source `page` (the default) always
   * reads YouTube's results page and never spends API search quota. `api-first` uses the Data
   * API while the budget lasts, then the results page (also with no key); `api-only` never falls
   * back.
   */
  async search(q: string, actor: SearchActor): Promise<SearchReply> {
    const key = this.#settings.apiKey();
    const source = this.#settings.searchSource();
    const fallback = source !== 'api-only';
    if (key === null && !fallback) {
      throw new HttpError(
        503,
        'search-disabled',
        'Search is off in this room. Use Find on YouTube and paste the link instead.',
      );
    }
    const now = this.#now();
    const query = normaliseQuery(q);
    const cached = this.#repos.searchCache.get(query);
    if (cached !== null && now - cached.fetchedAt < CACHE_TTL_MS) {
      const snippets = new Map<string, VideoRow>();
      for (const c of cached.cards ?? []) snippets.set(c.videoId, rowFromCard(c, cached.fetchedAt));
      return this.#reply(cached.videoIds, snippets, cached.provider, true, actor);
    }
    if (key === null || source === 'page') return this.#searchUnofficial(q, query, actor);

    const limits = this.#settings.data().limits;
    const day = pacificDay(now);
    const usage = this.#repos.searchUsage.get(day);
    const check = checkSearchBudget(limits, usage, actor);
    if (!check.ok) {
      if (fallback && EXHAUSTED.has(check.reason)) return this.#searchUnofficial(q, query, actor);
      throw new HttpError(
        429,
        check.reason === 'daily-quota' ? 'daily-quota' : 'search-budget',
        check.message,
        check.retryAfterSec,
      );
    }
    // Count before the call so concurrent searches see it.
    this.#repos.searchUsage.put(day, recordSearch(usage, actor), now);
    let items;
    try {
      items = await this.#api.search(key, q.trim());
    } catch (err) {
      if (err instanceof YouTubeHttpError && err.quotaExceeded) {
        const u = this.#repos.searchUsage.get(day);
        this.#repos.searchUsage.put(
          day,
          { ...u, total: Math.max(u.total, limits.search.dailyTotal) },
          now,
        );
        if (fallback) return this.#searchUnofficial(q, query, actor, true);
        throw new HttpError(
          429,
          'daily-quota',
          'Search is used up for today (YouTube’s daily limit). Use Find on YouTube instead, it always works.',
        );
      }
      throw new HttpError(502, 'youtube-unavailable', UNAVAILABLE);
    }
    const ids = items.map((i) => i.videoId);
    const snippets = new Map<string, VideoRow>();
    for (const i of items) {
      snippets.set(i.videoId, {
        videoId: i.videoId,
        title: i.title,
        channelTitle: i.channelTitle,
        ...(i.thumbnail !== undefined ? { thumbnail: i.thumbnail } : {}),
        missing: false,
        refreshedAt: now,
      });
    }
    this.#repos.searchCache.put(query, ids, now, 'youtube-api');
    return this.#reply(ids, snippets, 'youtube-api', false, actor);
  }

  /**
   * A results-page search. Guests keep the per-guest/per-IP interval (shared with the API path;
   * only the `lastAt` stamps are recorded, no budget is spent). `afterApiCall`: the same request
   * already passed the interval check on the API path.
   */
  async #searchUnofficial(
    q: string,
    query: string,
    actor: SearchActor,
    afterApiCall = false,
  ): Promise<SearchReply> {
    const now = this.#now();
    const day = pacificDay(now);
    if (!actor.isOwner && !afterApiCall) {
      const usage = this.#repos.searchUsage.get(day);
      const interval = this.#settings.data().limits.search.perGuestIntervalSec;
      const last = Math.max(
        usage.lastAtByGuest[actor.guestId] ?? -Infinity,
        usage.lastAtByIp[actor.ip] ?? -Infinity,
      );
      const waitMs = last + interval * 1000 - actor.now;
      if (waitMs > 0) {
        const retryAfterSec = Math.ceil(waitMs / 1000);
        throw new HttpError(
          429,
          'search-budget',
          `Please wait ${seconds(retryAfterSec)} before searching again; this room allows one search every ${seconds(interval)} (set by the owner).`,
          retryAfterSec,
        );
      }
      this.#repos.searchUsage.put(
        day,
        {
          ...usage,
          lastAtByGuest: { ...usage.lastAtByGuest, [actor.guestId]: actor.now },
          lastAtByIp: { ...usage.lastAtByIp, [actor.ip]: actor.now },
        },
        now,
      );
    }
    let cards: VideoCard[];
    try {
      cards = await this.#unofficial(q);
    } catch (err) {
      if (err instanceof UnofficialSearchError) {
        throw new HttpError(502, 'youtube-unavailable', UNAVAILABLE);
      }
      throw err;
    }
    const ids = cards.map((c) => c.videoId);
    const snippets = new Map(cards.map((c) => [c.videoId, rowFromCard(c, now)]));
    this.#repos.searchCache.put(query, ids, now, 'unofficial', cards);
    return this.#reply(ids, snippets, 'unofficial', false, actor);
  }

  /**
   * Cards in result order. With a key, `videos.list` pre-screens every result (1 unit per 50
   * IDs) and its rows win; otherwise the search snippet (API) or page snapshot (unofficial) is
   * used. `remaining` is the official budget on the API path and null on the unofficial path.
   */
  async #reply(
    ids: string[],
    snippets: Map<string, VideoRow>,
    provider: SearchProvider,
    cached: boolean,
    actor: SearchActor,
  ): Promise<SearchReply> {
    const rows = await this.lookupVideos(ids);
    const results = ids.map((id) => {
      const row = rows.get(id);
      return this.#card(id, row !== undefined && isApiRow(row) ? row : (snippets.get(id) ?? row));
    });
    let remaining: number | null = null;
    if (provider === 'youtube-api' && this.hasKey()) {
      const now = this.#now();
      const limits = this.#settings.data().limits;
      const usage = this.usage(now);
      const left = remainingSearches(usage, limits);
      remaining = actor.isOwner
        ? left.owner
        : Math.min(
            left.guests,
            Math.max(0, limits.search.perGuestPerDay - (usage.byGuest[actor.guestId] ?? 0)),
          );
    }
    return { results, remaining, cached, provider };
  }

  #card(videoId: string, row: VideoRow | undefined): VideoCard {
    const r = row ?? { videoId, title: videoId, missing: false, refreshedAt: 0 };
    const screen = this.prescreen(r.missing ? null : r);
    const card: VideoCard = {
      videoId,
      title: r.title,
      channelTitle: r.channelTitle ?? '',
      thumbnail: r.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      durationSec: r.durationSec ?? null,
      playable: screen.playable,
    };
    if (!screen.playable) {
      card.reason = screen.reason;
      card.source = screen.source;
      card.message = screen.message;
    }
    return card;
  }

  // -------------------------------------------------------------------------------------------
  // Fallback playlists

  /**
   * Imports (or refreshes, with `rowId`) a public or unlisted playlist. The first
   * `playlistItems.list` call validates it: 404 → `playlist-not-found`, 403 → `playlist-private`.
   */
  async importPlaylist(url: string, rowId?: string): Promise<PlaylistInfo> {
    const key = this.#settings.apiKey();
    if (key === null) {
      throw new HttpError(
        422,
        'no-api-key',
        'Add a YouTube API key in settings before importing playlists.',
      );
    }
    const playlistId = extractPlaylistId(url);
    if (playlistId === null) {
      throw new HttpError(
        422,
        'playlist-not-found',
        "That doesn't look like a YouTube playlist link.",
      );
    }
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
      let result;
      try {
        result = await this.#api.playlistItems(key, playlistId, pageToken);
      } catch (err) {
        if (page === 0 && err instanceof YouTubeHttpError) {
          if (err.status === 404) {
            throw new HttpError(422, 'playlist-not-found', "YouTube can't find that playlist.");
          }
          if (err.status === 403 && !err.quotaExceeded) {
            throw new HttpError(
              422,
              'playlist-private',
              'That playlist is private on YouTube. Make it public or unlisted, then try again.',
            );
          }
        }
        if (page === 0) {
          throw new HttpError(502, 'youtube-unavailable', 'YouTube is not answering right now.');
        }
        break;
      }
      for (const item of result.items) {
        const p = item.privacyStatus;
        if (p !== undefined && p !== 'public' && p !== 'unlisted') continue;
        if (!ids.includes(item.videoId)) ids.push(item.videoId);
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    await this.lookupVideos(ids);
    const canonical = `https://www.youtube.com/playlist?list=${playlistId}`;
    const o = await this.#api.oembed(canonical);
    const existing = rowId !== undefined ? this.#repos.playlists.get(rowId) : null;
    const row = {
      id: existing?.id ?? rowId ?? `pl-${randomUUID()}`,
      playlistId,
      title: o.ok ? o.data.title : (existing?.title ?? playlistId),
      url: existing?.url ?? url.trim(),
      videoCount: ids.length,
      importedAt: this.#now(),
      lastError: null,
    };
    this.#repos.playlists.upsert(row);
    this.#repos.playlists.setVideos(row.id, ids);
    return toPlaylistInfo(row);
  }

  /** Records a failed import attempt (setup imports keep going on errors). */
  recordPlaylistError(url: string, message: string): PlaylistInfo {
    const row = {
      id: `pl-${randomUUID()}`,
      playlistId: extractPlaylistId(url) ?? 'unknown',
      title: extractPlaylistId(url) ?? url,
      url: url.trim(),
      videoCount: 0,
      importedAt: this.#now(),
      lastError: message,
    };
    this.#repos.playlists.upsert(row);
    return toPlaylistInfo(row);
  }
}
