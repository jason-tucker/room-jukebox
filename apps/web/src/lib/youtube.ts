/** Minimal typings and loader for the YouTube IFrame Player API. */

export const YTState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getDuration(): number;
  getVideoData?(): { title?: string; video_id?: string };
  destroy(): void;
}

export interface YTEvent<T = unknown> {
  target: YTPlayer;
  data: T;
}

export interface YTPlayerOptions {
  width?: number | string;
  height?: number | string;
  videoId?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: YTEvent) => void;
    onStateChange?: (e: YTEvent<number>) => void;
    onError?: (e: YTEvent<number>) => void;
    onAutoplayBlocked?: (e: YTEvent) => void;
  };
}

interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

/** Injects `https://www.youtube.com/iframe_api` once and resolves when `YT.Player` exists. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the YouTube IFrame API (no internet?)'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export interface PlayerHandlers {
  onReady?: () => void;
  onStateChange?: (state: number) => void;
  onError?: (code: number) => void;
  onAutoplayBlocked?: () => void;
}

/**
 * Creates the one IFrame player for a page inside `container` (a fresh child element, so React
 * never owns the iframe). Player vars match the M0 spike: controls on, no related-video bias,
 * inline playback, `origin` set so YouTube accepts the embed (error 153 otherwise).
 */
export async function createYouTubePlayer(
  container: HTMLElement,
  handlers: PlayerHandlers,
): Promise<YTPlayer> {
  const YT = await loadYouTubeApi();
  const host = document.createElement('div');
  container.appendChild(host);
  return new YT.Player(host, {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      controls: 1,
      rel: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin,
    },
    events: {
      onReady: () => handlers.onReady?.(),
      onStateChange: (e) => handlers.onStateChange?.(e.data),
      onError: (e) => handlers.onError?.(Number(e.data)),
      onAutoplayBlocked: () => handlers.onAutoplayBlocked?.(),
    },
  });
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/**
 * Pulls a video ID out of whatever the guest pasted: a bare 11-character ID, a youtu.be /
 * youtube.com watch, shorts, live or embed link, or the share text of the YouTube app (a sentence
 * with a link in it). Returns null when nothing YouTube-shaped is found.
 */
export function parseYouTubeInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (ID_RE.test(text)) return text;
  const candidates =
    text.match(/(?:https?:\/\/)?[^\s]*(?:youtube(?:-nocookie)?\.com|youtu\.be)[^\s]*/gi) ?? [];
  for (const c of candidates) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(c) ? c : `https://${c}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!HOSTS.has(host)) continue;
    let id: string | null;
    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1] ?? null;
    } else if (url.searchParams.get('v')) {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
    if (id && ID_RE.test(id)) return id;
  }
  return null;
}

export function watchUrl(videoId: string | null | undefined): string {
  return videoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : 'https://www.youtube.com/';
}
