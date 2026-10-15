/** Pure parts of the updater: the quiet rule, the install window and the clock sanity check. */

export const QUIET_AFTER_MS = 2 * 60 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const INSTALL_WINDOW = { fromHour: 5, toHour: 12 } as const;

export interface QuietInput {
  now: number;
  /** Newest `source: 'request'` enqueue seen; `undefined` when the hub state is unknown. */
  lastRequestAt: number | undefined;
  /** Source of the current track; `null` when idle, `undefined` when the state is unknown. */
  nowPlayingSource: 'request' | 'auto' | null | undefined;
  tvConnected: boolean;
}

/**
 * Quiet = the TV display is disconnected, OR no request for 2 h and the current track is a
 * fallback (`auto`) track. An idle hub (nothing playing) counts like an `auto` track: there is
 * nothing to interrupt. Unknown state is never quiet.
 */
export function isQuiet(i: QuietInput): boolean {
  if (!i.tvConnected) return true;
  if (i.lastRequestAt === undefined || i.nowPlayingSource === undefined) return false;
  if (i.now - i.lastRequestAt < QUIET_AFTER_MS) return false;
  return i.nowPlayingSource === 'auto' || i.nowPlayingSource === null;
}

/** Local clock minus the server's `Date` header; `undefined` when the header is missing or bad. */
export function clockSkewMs(
  localNow: number,
  dateHeader: string | null | undefined,
): number | undefined {
  if (!dateHeader) return undefined;
  const server = Date.parse(dateHeader);
  return Number.isNaN(server) ? undefined : localNow - server;
}

export interface InstallInput {
  quiet: boolean;
  tvConnected: boolean;
  /** Local wall-clock hour 0..23. */
  localHour: number;
  skewMs: number | undefined;
  /** "Update now" from the tray or settings. */
  manual: boolean;
  /** Windows is logging off or shutting down. */
  sessionEnding: boolean;
}

export type InstallReason =
  | 'manual'
  | 'tv-disconnected'
  | 'quiet-in-window'
  | 'quiet-clock-skewed'
  | 'not-quiet'
  | 'outside-window'
  | 'session-end';

/**
 * Install now? Never during session-end; immediately on "Update now"; at any hour with the TV
 * unplugged; otherwise only when quiet inside 05:00–12:00. A local clock more than 5 min off the
 * update server's clock cannot be trusted for the window, so then quiet alone decides.
 */
export function installDecision(i: InstallInput): { install: boolean; reason: InstallReason } {
  if (i.sessionEnding) return { install: false, reason: 'session-end' };
  if (i.manual) return { install: true, reason: 'manual' };
  if (!i.tvConnected) return { install: true, reason: 'tv-disconnected' };
  if (!i.quiet) return { install: false, reason: 'not-quiet' };
  if (i.skewMs !== undefined && Math.abs(i.skewMs) > MAX_CLOCK_SKEW_MS) {
    return { install: true, reason: 'quiet-clock-skewed' };
  }
  const inWindow = i.localHour >= INSTALL_WINDOW.fromHour && i.localHour < INSTALL_WINDOW.toHour;
  return inWindow
    ? { install: true, reason: 'quiet-in-window' }
    : { install: false, reason: 'outside-window' };
}

/** The slice of AdminState (`GET /api/admin/session`) the quiet rule reads. */
export interface ActivitySnapshot {
  playback?: { nowPlaying?: { source?: string; enqueuedAt?: number } | null } | null;
  queue?: { source?: string; enqueuedAt?: number }[];
  recentHistory?: { source?: string; enqueuedAt?: number }[];
}

/**
 * Remembers the newest request across polls (recentHistory holds only 10 entries, less than
 * 2 h of music). Starts at app start, so a fresh launch waits 2 h before it counts as quiet.
 */
export class ActivityTracker {
  lastRequestAt: number | undefined;
  nowPlayingSource: 'request' | 'auto' | null | undefined;

  constructor(startedAt: number) {
    this.lastRequestAt = startedAt;
  }

  observe(state: ActivitySnapshot): void {
    const now = state.playback?.nowPlaying ?? null;
    const entries = [...(state.queue ?? []), ...(state.recentHistory ?? []), ...(now ? [now] : [])];
    for (const e of entries) {
      if (e.source === 'request' && typeof e.enqueuedAt === 'number') {
        this.lastRequestAt = Math.max(this.lastRequestAt ?? 0, e.enqueuedAt);
      }
    }
    this.nowPlayingSource =
      now === null
        ? null
        : now.source === 'auto' || now.source === 'request'
          ? now.source
          : undefined;
  }

  /** The hub state could not be read: stop claiming to know what is playing. */
  unknown(): void {
    this.nowPlayingSource = undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Update modes and feeds (M1.5 test phase)

export type UpdateMode = 'immediate' | 'quiet' | 'off';
export type UpdateFeed = 'tango' | 'github';

export const UPDATE_MODES: readonly UpdateMode[] = ['immediate', 'quiet', 'off'];
export const UPDATE_FEEDS: readonly UpdateFeed[] = ['tango', 'github'];

/** Tango's nginx container serving `/mnt/user/Public/RoomJukebox/`. */
export const DEFAULT_FEED_URL = 'http://192.168.1.5:8766/';
export const GITHUB_REPO = { owner: 'jason-tucker', repo: 'room-jukebox' } as const;
/** GitHub release assets (electron-builder tags `v<version>`). */
export const GITHUB_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/releases/download`;

export const IMMEDIATE_CHECK_MS = 10 * 60 * 1000;
export const QUIET_CHECK_MS = 6 * 60 * 60 * 1000;
/** Notice shown on the TV and phones before an `immediate` install. */
export const INSTALL_COUNTDOWN_MS = 15_000;

export function isUpdateMode(v: unknown): v is UpdateMode {
  return typeof v === 'string' && (UPDATE_MODES as readonly string[]).includes(v);
}

export function isUpdateFeed(v: unknown): v is UpdateFeed {
  return typeof v === 'string' && (UPDATE_FEEDS as readonly string[]).includes(v);
}

/** Feed check cadence: 10 min in `immediate`, 6 h in `quiet`, never when `off`. */
export function checkIntervalMs(mode: UpdateMode): number | undefined {
  if (mode === 'immediate') return IMMEDIATE_CHECK_MS;
  if (mode === 'quiet') return QUIET_CHECK_MS;
  return undefined;
}

/** A scheduled check is due at launch (no check yet) and then every `checkIntervalMs`. */
export function checkDue(mode: UpdateMode, lastCheckAt: number | undefined, now: number): boolean {
  const every = checkIntervalMs(mode);
  if (every === undefined) return false;
  return lastCheckAt === undefined || now - lastCheckAt >= every;
}

/** `http(s)://host[:port]/path/` with a trailing slash; throws on anything else. */
export function normalizeFeedUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`update feed must be http(s): ${url}`);
  }
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

export type FeedConfig =
  { provider: 'generic'; url: string } | { provider: 'github'; owner: string; repo: string };

/** electron-updater `setFeedURL` options for the chosen feed. */
export function feedConfig(feed: UpdateFeed, feedUrl: string): FeedConfig {
  return feed === 'tango'
    ? { provider: 'generic', url: normalizeFeedUrl(feedUrl) }
    : { provider: 'github', ...GITHUB_REPO };
}

/** Directory holding `latest.yml` and `latest.yml.sig` for the offered version. */
export function signatureBase(feed: UpdateFeed, feedUrl: string, version: string): string {
  return feed === 'tango'
    ? normalizeFeedUrl(feedUrl).replace(/\/+$/, '')
    : `${GITHUB_DOWNLOAD_BASE}/v${version}`;
}

/** The URL shown in the status for a feed (GitHub: the releases page). */
export function displayFeedUrl(feed: UpdateFeed, feedUrl: string): string {
  return feed === 'tango'
    ? normalizeFeedUrl(feedUrl)
    : `https://github.com/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/releases`;
}

export function countdownMessage(version: string, ms: number = INSTALL_COUNTDOWN_MS): string {
  return `Updating to ${version} in ${Math.round(ms / 1000)} s`;
}

export function updatedMessage(version: string, checklistItems: number): string {
  if (checklistItems <= 0) return `Updated to ${version}`;
  const things = checklistItems === 1 ? '1 thing' : `${checklistItems} things`;
  return `Updated to ${version} — ${things} to test in Admin → What's new`;
}
