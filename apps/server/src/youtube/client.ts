/**
 * YouTube Data API v3 + keyless oEmbed over an injectable `fetch`. Responses are validated with
 * loose zod schemas. The API key is sent as a query parameter and never logged.
 */
import { z } from 'zod';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://www.googleapis.com/youtube/v3';
const OEMBED = 'https://www.youtube.com/oembed';

export class YouTubeHttpError extends Error {
  readonly status: number;
  /** `error.errors[0].reason` from the API body, e.g. `quotaExceeded`, `playlistNotFound`. */
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }

  get quotaExceeded(): boolean {
    return (
      this.status === 403 &&
      (this.reason === 'quotaExceeded' || this.reason === 'dailyLimitExceeded')
    );
  }
}

const ThumbsSchema = z
  .record(z.string(), z.object({ url: z.string() }).loose())
  .optional()
  .catch(undefined);

const SnippetSchema = z
  .object({
    title: z.string().optional(),
    channelTitle: z.string().optional(),
    liveBroadcastContent: z.string().optional(),
    thumbnails: ThumbsSchema,
  })
  .loose();

const SearchResponseSchema = z.object({
  items: z
    .array(
      z
        .object({
          id: z.object({ videoId: z.string().optional() }).loose(),
          snippet: SnippetSchema.optional(),
        })
        .loose(),
    )
    .default([]),
});

export const VideoResourceSchema = z
  .object({
    id: z.string(),
    snippet: SnippetSchema.optional(),
    contentDetails: z
      .object({
        duration: z.string().optional(),
        contentRating: z.object({ ytRating: z.string().optional() }).loose().optional(),
        regionRestriction: z
          .object({
            allowed: z.array(z.string()).optional(),
            blocked: z.array(z.string()).optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
    status: z
      .object({
        embeddable: z.boolean().optional(),
        privacyStatus: z.string().optional(),
        madeForKids: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type VideoResource = z.infer<typeof VideoResourceSchema>;

const VideosResponseSchema = z.object({ items: z.array(VideoResourceSchema).default([]) });

const PlaylistItemsResponseSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z
        .object({
          snippet: SnippetSchema.optional(),
          contentDetails: z.object({ videoId: z.string().optional() }).loose().optional(),
          status: z.object({ privacyStatus: z.string().optional() }).loose().optional(),
        })
        .loose(),
    )
    .default([]),
});

const OEmbedSchema = z
  .object({
    title: z.string(),
    author_name: z.string().optional(),
    thumbnail_url: z.string().optional(),
  })
  .loose();
export type OEmbed = z.infer<typeof OEmbedSchema>;

const ErrorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        errors: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
      })
      .loose(),
  })
  .loose();

export interface SearchItem {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail?: string;
}

export interface PlaylistItem {
  videoId: string;
  title: string;
  privacyStatus?: string;
}

export interface PlaylistPage {
  items: PlaylistItem[];
  nextPageToken?: string;
}

export type OEmbedResult = { ok: true; data: OEmbed } | { ok: false; status: number };

/** One API call, for the quota log. */
export interface CallRecord {
  endpoint: 'search.list' | 'videos.list' | 'playlistItems.list' | 'oembed';
  units: number;
  status: number;
}

export interface YouTubeApi {
  search(key: string, q: string): Promise<SearchItem[]>;
  videos(key: string, ids: readonly string[]): Promise<VideoResource[]>;
  playlistItems(key: string, playlistId: string, pageToken?: string): Promise<PlaylistPage>;
  oembed(url: string): Promise<OEmbedResult>;
}

/** Best thumbnail URL from a snippet's thumbnails map. */
export function pickThumbnail(
  thumbs: Record<string, { url: string }> | undefined,
  videoId?: string,
): string | undefined {
  for (const k of ['medium', 'high', 'default', 'standard', 'maxres']) {
    const t = thumbs?.[k];
    if (t?.url) return t.url;
  }
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : undefined;
}

export function createYouTubeApi(
  fetchImpl: FetchLike,
  onCall: (call: CallRecord) => void = () => {},
): YouTubeApi {
  async function getJson<T extends z.ZodType>(
    endpoint: CallRecord['endpoint'],
    path: string,
    params: Record<string, string>,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = `${API}/${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      onCall({ endpoint, units: 1, status: 0 });
      throw new YouTubeHttpError(0, 'network', `YouTube is unreachable (${String(err)})`);
    }
    onCall({ endpoint, units: 1, status: res.status });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(body);
      const reason = parsed.success ? parsed.data.error.errors?.[0]?.reason : undefined;
      const message = parsed.success ? (parsed.data.error.message ?? '') : '';
      throw new YouTubeHttpError(res.status, reason, message || `YouTube returned ${res.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new YouTubeHttpError(502, 'bad-response', 'Unexpected YouTube reply');
    return parsed.data;
  }

  return {
    async search(key, q) {
      const data = await getJson(
        'search.list',
        'search',
        {
          part: 'snippet',
          type: 'video',
          videoEmbeddable: 'true',
          videoSyndicated: 'true',
          maxResults: '50',
          q,
          key,
        },
        SearchResponseSchema,
      );
      const out: SearchItem[] = [];
      for (const item of data.items) {
        const videoId = item.id.videoId;
        if (!videoId) continue;
        const thumbnail = pickThumbnail(item.snippet?.thumbnails, videoId);
        out.push({
          videoId,
          title: item.snippet?.title ?? videoId,
          channelTitle: item.snippet?.channelTitle ?? '',
          ...(thumbnail !== undefined ? { thumbnail } : {}),
        });
      }
      return out;
    },

    async videos(key, ids) {
      if (ids.length === 0) return [];
      const data = await getJson(
        'videos.list',
        'videos',
        { part: 'snippet,contentDetails,status', id: ids.slice(0, 50).join(','), key },
        VideosResponseSchema,
      );
      return data.items;
    },

    async playlistItems(key, playlistId, pageToken) {
      const data = await getJson(
        'playlistItems.list',
        'playlistItems',
        {
          part: 'snippet,contentDetails,status',
          playlistId,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
          key,
        },
        PlaylistItemsResponseSchema,
      );
      const items: PlaylistItem[] = [];
      for (const it of data.items) {
        const videoId = it.contentDetails?.videoId;
        if (!videoId) continue;
        const privacyStatus = it.status?.privacyStatus;
        items.push({
          videoId,
          title: it.snippet?.title ?? videoId,
          ...(privacyStatus !== undefined ? { privacyStatus } : {}),
        });
      }
      return { items, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
    },

    async oembed(target) {
      const url = `${OEMBED}?${new URLSearchParams({ url: target, format: 'json' }).toString()}`;
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      } catch {
        onCall({ endpoint: 'oembed', units: 0, status: 0 });
        return { ok: false, status: 0 };
      }
      onCall({ endpoint: 'oembed', units: 0, status: res.status });
      if (!res.ok) return { ok: false, status: res.status };
      const parsed = OEmbedSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502 };
    },
  };
}
