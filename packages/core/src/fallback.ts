/**
 * Fallback picker (plan §3.4): what plays when nobody has requested anything. Candidates are the
 * imported playlist videos plus past requests that played to the end; artists and tracks requested
 * in the last two hours weigh double; recently played videos are excluded while the pool allows.
 * Pure: the caller passes `rng` and `now`.
 */
import type { HistoryEntry } from './queue-machine.ts';

export interface FallbackVideo {
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnail?: string;
  durationSec?: number;
}

export interface FallbackPick extends FallbackVideo {
  origin: 'playlist' | 'history';
  /** How many recent plays were excluded for this pick (20, 10, 5, 1 or 0). */
  excludedWindow: number;
  /** 1 or 2 (recently requested artist or track). */
  weight: number;
}

export interface PickNextInput {
  playlistVideos: readonly FallbackVideo[];
  history: readonly HistoryEntry[];
  /** Video IDs in play order, oldest first (most recent last). */
  recentlyPlayed: readonly string[];
  /** Uniform in [0, 1), e.g. `Math.random` or a seeded generator. */
  rng: () => number;
  /** ms */
  now: number;
}

/**
 * The exclusion windows tried in order. The plan names 20, 10, 5, 0; the extra step of 1 keeps a
 * pool of two or more from repeating the track that just played.
 */
export const EXCLUSION_LADDER = [20, 10, 5, 1, 0] as const;
export const RECENT_REQUEST_WINDOW_MS = 2 * 60 * 60 * 1000;
export const RECENT_REQUEST_WEIGHT = 2;
export const DEFAULT_FAILURE_LIMIT = 5;

/** Artist = channel title when present, else the title's text before " - ", else null. */
export function artistOf(video: { title: string; channelTitle?: string }): string | null {
  const channel = video.channelTitle?.trim();
  if (channel) return channel.toLowerCase();
  const dash = video.title.indexOf(' - ');
  if (dash <= 0) return null;
  return video.title.slice(0, dash).trim().toLowerCase() || null;
}

function candidatePool(
  input: PickNextInput,
): (FallbackVideo & { origin: FallbackPick['origin'] })[] {
  const seen = new Set<string>();
  const pool: (FallbackVideo & { origin: FallbackPick['origin'] })[] = [];
  for (const v of input.playlistVideos) {
    if (seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    pool.push({ ...v, origin: 'playlist' });
  }
  for (const h of input.history) {
    if (h.source !== 'request' || h.status !== 'done' || seen.has(h.videoId)) continue;
    seen.add(h.videoId);
    const v: FallbackVideo & { origin: 'history' } = {
      videoId: h.videoId,
      title: h.title,
      origin: 'history',
    };
    if (h.channelTitle !== undefined) v.channelTitle = h.channelTitle;
    if (h.thumbnail !== undefined) v.thumbnail = h.thumbnail;
    if (h.durationSec !== undefined) v.durationSec = h.durationSec;
    pool.push(v);
  }
  return pool;
}

/**
 * Picks the next auto track. Returns null only when the pool (playlists ∪ done requests) is
 * empty. Deterministic for a given input and `rng` sequence (one `rng()` call per pick).
 */
export function pickNext(input: PickNextInput): FallbackPick | null {
  const pool = candidatePool(input);
  if (pool.length === 0) return null;

  const since = input.now - RECENT_REQUEST_WINDOW_MS;
  const hotTracks = new Set<string>();
  const hotArtists = new Set<string>();
  for (const h of input.history) {
    if (h.source !== 'request' || h.enqueuedAt < since) continue;
    hotTracks.add(h.videoId);
    const artist = artistOf(h);
    if (artist !== null) hotArtists.add(artist);
  }

  let window = 0;
  let eligible = pool;
  for (const n of EXCLUSION_LADDER) {
    const excluded = new Set(n === 0 ? [] : input.recentlyPlayed.slice(-n));
    const left = pool.filter((v) => !excluded.has(v.videoId));
    if (left.length > 0) {
      window = n;
      eligible = left;
      break;
    }
  }

  const weights = eligible.map((v) => {
    const artist = artistOf(v);
    const hot = hotTracks.has(v.videoId) || (artist !== null && hotArtists.has(artist));
    return hot ? RECENT_REQUEST_WEIGHT : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const r = Math.min(Math.max(input.rng(), 0), 1) * total;
  let acc = 0;
  let index = eligible.length - 1;
  for (let i = 0; i < eligible.length; i++) {
    acc += weights[i] as number;
    if (r < acc) {
      index = i;
      break;
    }
  }
  const chosen = eligible[index] as FallbackVideo & { origin: FallbackPick['origin'] };
  return { ...chosen, excludedWindow: window, weight: weights[index] as number };
}

/**
 * After this many consecutive failed fallback plays the hub stops and shows *Start Music / owner
 * assistance* (requests are kept).
 */
export function shouldStopRetrying(
  consecutiveFailures: number,
  limit: number = DEFAULT_FAILURE_LIMIT,
): boolean {
  return consecutiveFailures >= limit;
}
