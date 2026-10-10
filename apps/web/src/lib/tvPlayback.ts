import { decideSeek, expectedPosition } from '@room-jukebox/core';
import type { ClientMessage } from '@room-jukebox/shared';
import type { SessionClient } from './ws.ts';
import { createYouTubePlayer, YTState, type PlayerHandlers, type YTPlayer } from './youtube.ts';

/*
 * TV playback controller (plan §3.4 sync math, extracted from the M0 spike /tv page).
 *
 * - Follows `playback.nowPlaying` of the player projection: a new `revision` loads the video at the
 *   expected position; pause/resume mirrors `pausedAt`.
 * - Sync loop: expected = (serverNow − startedAt − accumulatedPauseMs) / 1000, frozen while paused;
 *   seek only when |drift| > dead band (1.25 s), at most once per 2.5 s, and only while the player
 *   is PLAYING and its clock visibly advances (ads, buffering and stalls are left alone).
 * - Reports `position` once per second and `event` (ended/error/autoplayBlocked/playing/stalled)
 *   tagged with the loaded revision. On `ended` it never advances locally: the hub decides.
 */

export const SYNC_INTERVAL_MS = 300;
export const REPORT_INTERVAL_MS = 1000;
export const AUTOPLAY_CHECK_MS = 3000;
export const FAILURE_SHOW_MS = 5000;
export const STALL_REPORT_MS = 8000;
export const LOCAL_DELAYED_SEC = 3;

export interface Tuning {
  deadBandSec: number;
  minSeekIntervalMs: number;
  leadSec: number;
}

export const DEFAULT_TUNING: Tuning = { deadBandSec: 1.25, minSeekIntervalMs: 2500, leadSec: 0 };

type EventKind = Extract<ClientMessage, { type: 'event' }>['kind'];

export interface TvSnapshot {
  needsStart: boolean;
  failure: string | null;
  drift: number | null;
  playerError: string | null;
  ready: boolean;
}

export class TvPlayback {
  needsStart = false;
  drift: number | null = null;
  playerError: string | null = null;
  ready = false;

  #client: SessionClient<'player'>;
  #container: HTMLElement;
  #tuning: Tuning;
  #create: (el: HTMLElement, h: PlayerHandlers) => Promise<YTPlayer>;
  #player: YTPlayer | null = null;
  #disposed = false;
  #loadedRevision = -1;
  #loadedTitle: string | null = null;
  #previousTitle: string | null = null;
  #mirroredPaused = false;
  #lastSeekAt: number | null = null;
  #lastActual: number | null = null;
  #notAdvancingSince: number | null = null;
  #autoplayTimer: ReturnType<typeof setTimeout> | undefined;
  #timers: ReturnType<typeof setInterval>[] = [];
  #sent = new Map<EventKind, number>();
  #failure: { text: string; until: number } | null = null;
  #lastErrorAt: number | null = null;
  #sample: { actual: number | null; ps: number | null } = { actual: null, ps: null };
  #listeners = new Set<() => void>();
  #unsubscribe: (() => void) | null = null;

  constructor(
    client: SessionClient<'player'>,
    container: HTMLElement,
    tuning: Tuning = DEFAULT_TUNING,
    create: (el: HTMLElement, h: PlayerHandlers) => Promise<YTPlayer> = createYouTubePlayer,
  ) {
    this.#client = client;
    this.#container = container;
    this.#tuning = tuning;
    this.#create = create;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  snapshot(): TvSnapshot {
    if (this.#failure && Date.now() > this.#failure.until) this.#failure = null;
    return {
      needsStart: this.needsStart,
      failure: this.#failure?.text ?? null,
      drift: this.drift,
      playerError: this.playerError,
      ready: this.ready,
    };
  }

  start(): void {
    this.#unsubscribe = this.#client.subscribe(() => this.#applyState());
    this.#create(this.#container, {
      onReady: () => {
        this.ready = true;
        this.#applyState();
        this.#emit();
      },
      onStateChange: (s) => this.#onStateChange(s),
      onError: (code) => this.#onError(code),
      onAutoplayBlocked: () => this.#markBlocked(),
    }).then(
      (p) => {
        if (this.#disposed) {
          try {
            p.destroy();
          } catch {
            // already gone
          }
          return;
        }
        this.#player = p;
        if (this.ready) this.#applyState();
      },
      (err: unknown) => {
        this.playerError = err instanceof Error ? err.message : String(err);
        this.#emit();
      },
    );
    this.#timers.push(setInterval(() => this.#syncTick(), SYNC_INTERVAL_MS));
    this.#timers.push(setInterval(() => this.#report(), REPORT_INTERVAL_MS));
  }

  stop(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    for (const t of this.#timers) clearInterval(t);
    clearTimeout(this.#autoplayTimer);
    try {
      this.#player?.destroy();
    } catch {
      // already gone
    }
    this.#player = null;
    this.#container.replaceChildren();
  }

  /** The Start Music gesture: a real user gesture lets `playVideo()` start with sound. */
  startMusic(): void {
    if (!this.#player) return;
    this.needsStart = false;
    this.#player.playVideo();
    this.#armAutoplayCheck();
    this.#emit();
  }

  /** Forget the seek rate limit (the page became visible again: resync now). */
  resyncNow(): void {
    this.#lastSeekAt = null;
  }

  #state() {
    return this.#client.state;
  }

  #sendEvent(kind: EventKind, code?: number): void {
    if (this.#sent.get(kind) === this.#loadedRevision) return;
    this.#sent.set(kind, this.#loadedRevision);
    this.#client.send({
      type: 'event',
      kind,
      revision: Math.max(0, this.#loadedRevision),
      ...(code !== undefined ? { code } : {}),
    });
  }

  #markBlocked(): void {
    this.needsStart = true;
    this.#sendEvent('autoplayBlocked');
    this.#emit();
  }

  #flashFailure(title: string | null): void {
    this.#failure = { text: title ?? '', until: Date.now() + FAILURE_SHOW_MS };
    this.#emit();
  }

  /** "Blocked" heuristic: still unstarted/cued 3 s after asking to play. */
  #armAutoplayCheck(): void {
    clearTimeout(this.#autoplayTimer);
    this.#autoplayTimer = setTimeout(() => {
      const p = this.#player;
      if (!p || this.#mirroredPaused) return;
      const ps = p.getPlayerState();
      if (ps === YTState.UNSTARTED || ps === YTState.CUED) this.#markBlocked();
    }, AUTOPLAY_CHECK_MS);
  }

  #onStateChange(s: number): void {
    if (s === YTState.PLAYING) {
      clearTimeout(this.#autoplayTimer);
      if (this.needsStart) {
        this.needsStart = false;
        this.#emit();
      }
      this.#sendEvent('playing');
    } else if (s === YTState.ENDED) {
      // Never advance locally: the hub decides (single transition rule).
      this.#sendEvent('ended');
    }
  }

  #onError(code: number): void {
    clearTimeout(this.#autoplayTimer);
    this.#flashFailure(this.#loadedTitle);
    this.#lastErrorAt = Date.now();
    this.#sendEvent('error', code);
  }

  #applyState(): void {
    const state = this.#state();
    if (!state) return;

    // A failure the hub saw (this player or the pre-screen): show the line once for 5 s.
    const le = state.lastError;
    if (le && le.at !== this.#lastErrorAt) {
      const fresh = this.#client.serverNow() - le.at < FAILURE_SHOW_MS;
      // `stopped` (fallback gave up) is a standing condition the page shows itself.
      const shownLocally = this.#failure !== null || le.code === 'stopped';
      if (fresh && !shownLocally) this.#flashFailure(this.#previousTitle ?? le.message);
      this.#lastErrorAt = le.at;
    }

    const player = this.#player;
    if (!player || !this.ready) return;
    const np = state.playback.nowPlaying;
    if (!np) {
      if (this.#loadedRevision !== state.revision) {
        this.#previousTitle = this.#loadedTitle;
        this.#loadedRevision = state.revision;
        this.#loadedTitle = null;
        player.stopVideo();
      }
      return;
    }
    if (state.revision !== this.#loadedRevision) {
      this.#previousTitle = this.#loadedTitle;
      this.#loadedRevision = state.revision;
      this.#loadedTitle = np.title;
      const startSeconds = expectedPosition(np, this.#client.serverNow());
      this.#mirroredPaused = np.pausedAt !== null;
      this.#lastSeekAt = Date.now();
      this.#lastActual = null;
      this.#notAdvancingSince = null;
      if (this.#mirroredPaused) {
        player.cueVideoById({ videoId: np.videoId, startSeconds });
      } else {
        player.loadVideoById({ videoId: np.videoId, startSeconds });
        this.#armAutoplayCheck();
      }
      return;
    }
    const paused = np.pausedAt !== null;
    if (paused !== this.#mirroredPaused) {
      this.#mirroredPaused = paused;
      if (paused) {
        player.pauseVideo();
      } else {
        player.playVideo();
        this.#armAutoplayCheck();
      }
    }
  }

  #syncTick(): void {
    const state = this.#state();
    const np = state?.playback.nowPlaying;
    const player = this.#player;
    if (!player || !this.ready || !state || !np || this.#loadedRevision !== state.revision) {
      this.#sample = { actual: null, ps: player && this.ready ? player.getPlayerState() : null };
      if (this.drift !== null) {
        this.drift = null;
        this.#emit();
      }
      return;
    }
    const now = Date.now();
    const expected = expectedPosition(np, this.#client.serverNow());
    const actual = player.getCurrentTime();
    const ps = player.getPlayerState();
    const advancing =
      ps === YTState.PLAYING && this.#lastActual !== null && actual - this.#lastActual > 0.05;
    this.#lastActual = actual;
    this.#sample = { actual, ps };
    this.drift = actual - expected;

    if (np.pausedAt !== null) {
      this.#notAdvancingSince = null;
      if (ps === YTState.PLAYING) player.pauseVideo();
      return;
    }
    if (!advancing) {
      // Stalled (ad, buffering, network): report once per revision, never seek.
      if (!this.needsStart) {
        this.#notAdvancingSince ??= now;
        if (now - this.#notAdvancingSince > STALL_REPORT_MS) this.#sendEvent('stalled');
      }
      return;
    }
    this.#notAdvancingSince = null;
    const decision = decideSeek({
      expected: expected + this.#tuning.leadSec,
      actual,
      lastSeekAt: this.#lastSeekAt,
      now,
      deadBandSec: this.#tuning.deadBandSec,
      minSeekIntervalMs: this.#tuning.minSeekIntervalMs,
    });
    if (decision.seek && decision.to !== undefined) {
      player.seekTo(decision.to, true);
      this.#lastSeekAt = now;
      this.#lastActual = null;
    }
  }

  #report(): void {
    if (!this.#player || !this.ready || this.#sample.actual === null || this.#sample.ps === null) {
      return;
    }
    this.#client.send({
      type: 'position',
      position: this.#sample.actual,
      playerState: this.#sample.ps,
      revision: Math.max(0, this.#loadedRevision),
    });
  }
}
