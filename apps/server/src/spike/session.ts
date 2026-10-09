import { applyEnded, expectedPosition } from '@room-jukebox/core';
import {
  PROTOCOL_VERSION,
  SPIKE_MATRIX,
  type MatrixEntry,
  type SpikeNowPlaying,
  type SpikePlayer,
  type SpikeState,
} from '@room-jukebox/shared';

/** |drift| above this for `DELAYED_AFTER_REPORTS` consecutive reports marks a player Delayed. */
export const DELAYED_DRIFT_SEC = 3;
export const DELAYED_AFTER_REPORTS = 3;
/** |drift| at or below this returns a Delayed player to Online. */
export const ONLINE_DRIFT_SEC = 1.5;
/** A player with no message for this long becomes Reconnecting. */
export const RECONNECTING_AFTER_MS = 10_000;
/** After this many error-driven advances with no player reaching `playing`, errors stop advancing. */
export const MAX_ERROR_STREAK = 5;

/** YT.PlayerState values for which a reported position is meaningful for drift. */
const DRIFT_STATES = new Set([1, 2, 3]); // playing, paused, buffering

interface TrackState {
  revision: number;
  nowPlaying: SpikeNowPlaying | null;
  /** Matrix index of the current (or most recent matrix) video; -1 before any. */
  cursor: number;
}

interface PlayerRecord extends SpikePlayer {
  overCount: number;
}

export interface SpikeErrorRecord {
  playerId: string;
  playerName: string;
  origin: string;
  videoId: string;
  code: number | undefined;
  revision: number;
}

/**
 * In-memory single-group spike session (M0). Track transitions go through the core single
 * transition rule; everything else (pause, seek, player status) changes state without bumping the
 * revision. `onChange` fires after every observable change.
 */
export class SpikeSession {
  readonly matrix: readonly MatrixEntry[];
  #now: () => number;
  #track: TrackState = { revision: 0, nowPlaying: null, cursor: -1 };
  #players = new Map<string, PlayerRecord>();
  /** videoId per revision, so late error reports are attributed to the right video. */
  #videoByRevision = new Map<number, string>();
  #listeners = new Set<() => void>();
  #autoAdvance = true;
  #errorStreak = 0;

  constructor(options: { now?: () => number; matrix?: readonly MatrixEntry[] } = {}) {
    this.#now = options.now ?? Date.now;
    this.matrix = options.matrix ?? SPIKE_MATRIX;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  get revision(): number {
    return this.#track.revision;
  }

  snapshot(): SpikeState {
    return {
      revision: this.#track.revision,
      serverTime: this.#now(),
      protocolVersion: PROTOCOL_VERSION,
      nowPlaying: this.#track.nowPlaying ? { ...this.#track.nowPlaying } : null,
      autoAdvance: this.#autoAdvance,
      errorStreak: this.#errorStreak,
      players: [...this.#players.values()].map(({ overCount: _overCount, ...p }) => ({
        ...p,
        lastError: p.lastError ? { ...p.lastError } : null,
      })),
    };
  }

  #start(videoId: string, title: string | undefined): SpikeNowPlaying {
    return {
      videoId,
      ...(title !== undefined ? { title } : {}),
      startedAt: this.#now(),
      pausedAt: null,
      accumulatedPauseMs: 0,
    };
  }

  #advance = (s: TrackState): TrackState => {
    if (this.matrix.length === 0) return { ...s, nowPlaying: null };
    const cursor = (s.cursor + 1) % this.matrix.length;
    const entry = this.matrix[cursor] as MatrixEntry;
    return { ...s, cursor, nowPlaying: this.#start(entry.videoId, entry.title) };
  };

  #commit(next: TrackState): void {
    this.#track = next;
    if (next.nowPlaying) this.#videoByRevision.set(next.revision, next.nowPlaying.videoId);
    this.#videoByRevision.delete(next.revision - 100);
    for (const p of this.#players.values()) p.overCount = 0;
    this.#changed();
  }

  setAutoAdvance(enabled: boolean): SpikeState {
    if (this.#autoAdvance !== enabled) {
      this.#autoAdvance = enabled;
      this.#changed();
    }
    return this.snapshot();
  }

  play(videoId: string, title?: string): SpikeState {
    this.#errorStreak = 0;
    const index = this.matrix.findIndex((e) => e.videoId === videoId);
    const resolvedTitle = title ?? (index >= 0 ? this.matrix[index]?.title : undefined);
    this.#commit({
      revision: this.#track.revision + 1,
      cursor: index >= 0 ? index : this.#track.cursor,
      nowPlaying: this.#start(videoId, resolvedTitle),
    });
    return this.snapshot();
  }

  /** Admin skip: always advances (no revision check), to the next matrix video. */
  next(): SpikeState {
    this.#errorStreak = 0;
    this.#commit(applyEnded(this.#track, this.#track.revision, this.#advance).state);
    return this.snapshot();
  }

  pause(): SpikeState {
    const np = this.#track.nowPlaying;
    if (np && np.pausedAt === null) {
      np.pausedAt = this.#now();
      this.#changed();
    }
    return this.snapshot();
  }

  resume(): SpikeState {
    const np = this.#track.nowPlaying;
    if (np && np.pausedAt !== null) {
      np.accumulatedPauseMs += this.#now() - np.pausedAt;
      np.pausedAt = null;
      this.#changed();
    }
    return this.snapshot();
  }

  seek(position: number): SpikeState {
    const np = this.#track.nowPlaying;
    if (np) {
      const now = this.#now();
      np.startedAt = now - position * 1000;
      np.accumulatedPauseMs = 0;
      if (np.pausedAt !== null) np.pausedAt = now;
      for (const p of this.#players.values()) p.overCount = 0;
      this.#changed();
    }
    return this.snapshot();
  }

  hello(playerId: string, name: string, origin: string): void {
    const existing = this.#players.get(playerId);
    this.#players.set(playerId, {
      id: playerId,
      name,
      origin,
      lastSeen: this.#now(),
      position: existing?.position ?? null,
      drift: existing?.drift ?? null,
      status: 'online',
      playingRevision: existing?.playingRevision ?? null,
      lastError: existing?.lastError ?? null,
      overCount: 0,
    });
    this.#changed();
  }

  /** Liveness from any message on the player's socket (pings arrive every 2 s even when idle). */
  touch(playerId: string): void {
    const p = this.#players.get(playerId);
    if (!p) return;
    p.lastSeen = this.#now();
    if (p.status === 'reconnecting') {
      p.status = 'online';
      this.#changed();
    }
  }

  player(playerId: string): SpikePlayer | undefined {
    return this.#players.get(playerId);
  }

  position(playerId: string, position: number, playerState: number, revision: number): void {
    const p = this.#players.get(playerId);
    if (!p) return;
    const now = this.#now();
    p.lastSeen = now;
    p.position = position;
    const np = this.#track.nowPlaying;
    p.drift =
      np && revision === this.#track.revision && DRIFT_STATES.has(playerState)
        ? position - expectedPosition(np, now)
        : null;

    if (p.status === 'blocked' && playerState !== 1) {
      // stays blocked until it actually plays
    } else if (p.drift === null) {
      if (p.status !== 'delayed') p.status = 'online';
    } else if (Math.abs(p.drift) > DELAYED_DRIFT_SEC) {
      p.overCount += 1;
      if (p.overCount >= DELAYED_AFTER_REPORTS) p.status = 'delayed';
      else if (p.status !== 'delayed') p.status = 'online';
    } else {
      p.overCount = 0;
      if (Math.abs(p.drift) <= ONLINE_DRIFT_SEC || p.status !== 'delayed') p.status = 'online';
    }
    this.#changed();
  }

  /**
   * Applies a player event. `ended` and `error` go through the single transition rule; an `error`
   * is also returned as a record for the results log (even when it does not advance).
   */
  event(
    playerId: string,
    kind: 'ended' | 'error' | 'autoplayBlocked' | 'playing',
    revision: number,
    code?: number,
  ): { committed: boolean; error?: SpikeErrorRecord } {
    const p = this.#players.get(playerId);
    if (p) p.lastSeen = this.#now();
    let committed = false;
    let error: SpikeErrorRecord | undefined;

    if (kind === 'ended' || kind === 'error') {
      if (kind === 'error') {
        error = {
          playerId,
          playerName: p?.name ?? '',
          origin: p?.origin ?? '',
          videoId: this.#videoByRevision.get(revision) ?? '(unknown)',
          code,
          revision,
        };
        if (p) p.lastError = { code: code ?? -1, revision };
      }
      const allowed =
        this.#autoAdvance && (kind === 'ended' || this.#errorStreak < MAX_ERROR_STREAK);
      if (this.#track.nowPlaying && allowed) {
        const result = applyEnded(this.#track, revision, this.#advance);
        if (result.committed) {
          committed = true;
          this.#errorStreak = kind === 'error' ? this.#errorStreak + 1 : 0;
          this.#commit(result.state);
          return { committed, ...(error ? { error } : {}) };
        }
      }
    } else if (kind === 'autoplayBlocked') {
      if (p) p.status = 'blocked';
    } else if (kind === 'playing') {
      if (revision === this.#track.revision) this.#errorStreak = 0;
      if (p) {
        p.playingRevision = revision;
        if (p.status === 'blocked' || p.status === 'reconnecting') p.status = 'online';
      }
    }
    this.#changed();
    return { committed, ...(error ? { error } : {}) };
  }

  disconnect(playerId: string): void {
    const p = this.#players.get(playerId);
    if (!p || p.status === 'reconnecting') return;
    p.status = 'reconnecting';
    this.#changed();
  }

  /** Marks silent players Reconnecting; returns true when anything changed. */
  sweep(): boolean {
    const now = this.#now();
    let changed = false;
    for (const p of this.#players.values()) {
      if (p.status !== 'reconnecting' && now - p.lastSeen > RECONNECTING_AFTER_MS) {
        p.status = 'reconnecting';
        changed = true;
      }
    }
    if (changed) this.#changed();
    return changed;
  }
}
