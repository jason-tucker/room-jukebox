/**
 * One group's live session: the core queue machine plus pause clock, fallback, player status,
 * leader election and failure handling. M2 runs one instance per group (`groups.ts`); the main
 * group keeps the M1 `session` row. Every observable change is persisted (queue, history, session
 * metadata) and then announced to listeners with a new `changeSeq`.
 *
 * Track transitions go only through core: `transition()` (player reports, revision-guarded),
 * `ownerSkip()`/`remove()` (owner), `enqueueRequest()`/`enqueueAuto()` and `restoreAfterRestart()`.
 */
import { randomUUID } from 'node:crypto';
import {
  checkRequest,
  emptyQueueState,
  evaluateVideo,
  enqueueAuto,
  enqueueRequest,
  expectedPosition,
  findByIdempotencyKey,
  ownerSkip,
  pickNext,
  remove,
  reorder,
  restoreAfterRestart,
  shouldStopRetrying,
  transition,
} from '@room-jukebox/core';
import type {
  Entry,
  FallbackVideo,
  HistoryEntry,
  LimitCheck,
  MachineResult,
  QueueState,
  RequestRejection,
} from '@room-jukebox/core';
import {
  M2_PROTOCOL_VERSION,
  type AdminState,
  type GuestState,
  type M1NowPlaying as NowPlaying,
  type Playback,
  type PlayerInfo,
  type PlayerState,
} from '@room-jukebox/shared';
import type { Repos, SessionData } from '../db/repo.ts';
import { emptySessionData, MAIN_GROUP_ID } from '../db/repo.ts';
import type { LanProvider } from '../lan.ts';
import type { FriendlyCheck } from '../friendly.ts';
import { joinUrl, lanReply, wifiQrPayload } from '../lan.ts';
import type { SettingsService } from '../settings.ts';
import type { YouTubeService } from '../youtube/service.ts';
import { metaOf } from '../youtube/service.ts';
import {
  OWNER_GUEST_ID,
  OWNER_NAME,
  playerErrorMessage,
  toEntryAdmin,
  toEntryPublic,
} from './projections.ts';

/** |drift| above this for `DELAYED_AFTER_REPORTS` consecutive reports marks a player Delayed. */
export const DELAYED_DRIFT_SEC = 3;
export const DELAYED_AFTER_REPORTS = 3;
export const ONLINE_DRIFT_SEC = 1.5;
/** A connected player silent for this long becomes Reconnecting. */
export const RECONNECTING_AFTER_MS = 10_000;
/** A disconnected player becomes Offline after this long. */
export const OFFLINE_AFTER_MS = 60_000;
/** The leader must have been heard from within this window (else the next oldest leads). */
export const LEADER_FAILOVER_MS = 5_000;
/** Hard cap on queued entries. */
export const MAX_QUEUE = 300;
const RECENT_HISTORY = 10;
const LAST_ERRORS = 5;
const POSITION_SAVE_MS = 5_000;
const DRIFT_STATES = new Set([1, 2, 3]);

export const STOPPED_MESSAGE =
  'Several videos in a row failed to play. Press Start Music, or ask the owner for help.';

type PlayerStatus = PlayerInfo['status'];

/** A player's live status (moves with the player between groups). */
export interface LivePlayer {
  id: string;
  name: string;
  /** Leader order: lower = older (the room's creation time). */
  order: number;
  lanAddress: string | null;
  status: PlayerStatus;
  lastSeen: number;
  drift: number | null;
  overCount: number;
  sockets: number;
  disconnectedAt: number | null;
  lastError: { code?: string; message: string; at: number } | null;
  autoplayBlocked: boolean;
}

export interface RequestInput {
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnail?: string;
  durationSec?: number;
  idempotencyKey: string;
  /** `null` for owner adds. */
  guestId: string | null;
  name: string | null;
  ip: string;
}

export type RequestCheck = LimitCheck<RequestRejection | 'queue-full'>;

export interface SessionDeps {
  /** Default: the main group. */
  groupId?: string;
  /** The room name shown to this group's pages (default: the settings' room name). */
  roomName?: () => string;
  repos: Repos;
  settings: SettingsService;
  youtube: YouTubeService;
  lan: LanProvider;
  friendly?: FriendlyCheck;
  now: () => number;
  rng: () => number;
  onError?: (err: unknown) => void;
}

/** A track failed at play time (`stopped`: the fallback gave up after repeated failures). */
export interface PlayFailure {
  entry: Entry | null;
  reason: string;
  stopped: boolean;
}

export class Session {
  #failListeners = new Set<(f: PlayFailure) => void>();
  #d: SessionDeps;
  #state: QueueState;
  #ips: Map<string, string>;
  #meta: SessionData;
  #changeSeq: number;
  #persistedHistory: number;
  #players = new Map<string, LivePlayer>();
  #listeners = new Set<() => void>();
  /** A fallback pick waits for a player to come online (idle policy). */
  #pendingFallback = false;
  /**
   * Nobody has heard the current track in this run (it started with no player online, or it was
   * restored from the database at boot): the first player to connect re-anchors its clock once,
   * at `#resumeFromSec`.
   */
  #unheard = false;
  #resumeFromSec = 0;
  #playerSeenSinceBoot = false;
  #restartChecked = false;
  #lastPositionSave = 0;
  #persistError = false;
  #closed = false;
  #groupId: string;
  #lastLeader: string | null = null;

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.#groupId = deps.groupId ?? MAIN_GROUP_ID;
    const stored = deps.repos.queue.load(this.#groupId);
    const history = deps.repos.history.loadAll(this.#groupId);
    const meta = deps.repos.session.load(this.#groupId);
    this.#state = {
      ...emptyQueueState(),
      revision: meta?.revision ?? 0,
      nowPlaying: stored.nowPlaying,
      queue: stored.queue,
      history,
    };
    this.#ips = stored.ips;
    this.#meta = meta?.data ?? emptySessionData();
    this.#changeSeq = meta?.changeSeq ?? 0;
    this.#persistedHistory = history.length;
    if (this.#state.nowPlaying !== null) {
      // A restored track's `startedAt` is from the previous run (possibly hours ago): resume it
      // from the last reported position when a player connects, not from a stale clock.
      this.#unheard = true;
      this.#resumeFromSec =
        this.#meta.positionRevision === this.#state.revision ? this.#meta.lastPositionSec : 0;
    }
  }

  get groupId(): string {
    return this.#groupId;
  }

  get revision(): number {
    return this.#state.revision;
  }

  get changeSeq(): number {
    return this.#changeSeq;
  }

  /** Read-only view of the queue machine state (tests and diagnostics). */
  get state(): QueueState {
    return this.#state;
  }

  get meta(): Readonly<SessionData> {
    return this.#meta;
  }

  onPlayFailure(listener: (f: PlayFailure) => void): () => void {
    this.#failListeners.add(listener);
    return () => this.#failListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -------------------------------------------------------------------------------------------
  // Commit, persistence and effects

  #persist(): void {
    if (this.#closed) return;
    const { repos } = this.#d;
    const now = this.#d.now();
    try {
      repos.queue.replace(this.#state.nowPlaying, this.#state.queue, this.#ips, this.#groupId);
      const fresh = this.#state.history.slice(this.#persistedHistory);
      if (fresh.length > 0) repos.history.append(fresh, this.#groupId);
      this.#persistedHistory = this.#state.history.length;
      repos.session.save(
        { revision: this.#state.revision, changeSeq: this.#changeSeq, data: this.#meta },
        now,
        this.#groupId,
      );
      this.#persistError = false;
    } catch (err) {
      this.#persistError = true;
      this.#d.onError?.(err);
    }
  }

  /** Bumps `changeSeq`, persists, and notifies (one broadcast). */
  #commit(): void {
    this.#lastLeader = this.#leader()?.id ?? null;
    this.#changeSeq += 1;
    this.#persist();
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        this.#d.onError?.(err);
      }
    }
  }

  #anyPlayerConnected(): boolean {
    for (const p of this.#players.values()) if (p.sockets > 0) return true;
    return false;
  }

  /** Applies a machine result and its effects (play → reset clock; needFallback → pick). */
  #apply(r: MachineResult): void {
    this.#state = r.state;
    for (const eff of r.effects) {
      if (eff.type === 'play') {
        this.#meta.pausedAt = null;
        this.#meta.accumulatedPauseMs = 0;
        this.#meta.clockRevision = eff.revision;
        this.#unheard = !this.#anyPlayerConnected();
        this.#resumeFromSec = 0;
        for (const p of this.#players.values()) p.overCount = 0;
        this.#d.repos.events.append(
          'play',
          { revision: eff.revision, entryId: eff.entry.id, videoId: eff.entry.videoId },
          this.#d.now(),
        );
      } else if (eff.type === 'needFallback') {
        this.#fallback();
      }
    }
  }

  /** Playable playlist videos (unknown metadata counts as playable). */
  #playlistVideos(): FallbackVideo[] {
    const d = this.#d.settings.data();
    const out: FallbackVideo[] = [];
    for (const { video, row } of this.#d.repos.playlists.allVideos()) {
      if (row !== null) {
        const screen = evaluateVideo(metaOf(row), {
          maxDurationSec: d.limits.maxDurationSec,
          country: d.country,
        });
        if (!screen.playable) continue;
      }
      out.push(video.title ? video : { ...video, title: video.videoId });
    }
    return out;
  }

  #fallback(): void {
    if (this.#state.nowPlaying !== null || this.#state.queue.length > 0) return;
    if (this.#meta.stopped) return;
    if (shouldStopRetrying(this.#meta.consecutiveFailures)) {
      this.#meta.stopped = true;
      return;
    }
    if (!this.#anyPlayerConnected()) {
      this.#pendingFallback = true;
      return;
    }
    this.#pendingFallback = false;
    const now = this.#d.now();
    const recentlyPlayed = this.#state.history.slice(-25).map((h) => h.videoId);
    const pick = pickNext({
      playlistVideos: this.#playlistVideos(),
      history: this.#state.history,
      recentlyPlayed,
      rng: this.#d.rng,
      now,
    });
    if (pick === null) return;
    const entry: Parameters<typeof enqueueAuto>[1] = {
      id: `auto:${randomUUID()}`,
      videoId: pick.videoId,
      title: pick.title,
      enqueuedAt: now,
    };
    if (pick.channelTitle !== undefined) entry.channelTitle = pick.channelTitle;
    if (pick.thumbnail !== undefined) entry.thumbnail = pick.thumbnail;
    if (pick.durationSec !== undefined) entry.durationSec = pick.durationSec;
    this.#apply(enqueueAuto(this.#state, entry));
  }

  // -------------------------------------------------------------------------------------------
  // Start-up

  /**
   * Restart rule (plan §3.4): called once, `graceMs` after start-up. When no player connected in
   * that window, the interrupted track is restarted once (or advanced) via `restoreAfterRestart`.
   */
  applyRestartRule(): boolean {
    if (this.#restartChecked) return false;
    this.#restartChecked = true;
    if (this.#playerSeenSinceBoot) return false;
    if (this.#state.nowPlaying === null && (this.#meta.stopped || this.#state.queue.length === 0)) {
      if (!this.#meta.stopped) this.#pendingFallback = true;
      return false;
    }
    const np = this.#state.nowPlaying;
    const positionSec =
      np !== null && this.#meta.positionRevision === this.#state.revision
        ? this.#meta.lastPositionSec
        : 0;
    this.#apply(restoreAfterRestart(this.#state, { now: this.#d.now(), positionSec }));
    this.#d.repos.events.append('restart-rule', { revision: this.#state.revision }, this.#d.now());
    this.#commit();
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  findByKey(key: string): Entry | HistoryEntry | undefined {
    return findByIdempotencyKey(this.#state, key);
  }

  /** The room's request limits (`ip`/`guestId` counters from the live queue and history). */
  checkRequest(input: {
    guestId: string;
    ip: string;
    videoId: string;
    durationSec?: number;
  }): RequestCheck {
    if (this.#state.queue.length >= MAX_QUEUE) {
      return {
        ok: false,
        reason: 'queue-full',
        message: `The queue is full (${MAX_QUEUE} songs). Try again after a few have played.`,
      };
    }
    const pendingByGuest: Record<string, number> = {};
    const pendingByIp: Record<string, number> = {};
    const lastByGuest: Record<string, number> = {};
    const lastByIp: Record<string, number> = {};
    for (const e of this.#state.queue) {
      if (e.source !== 'request') continue;
      if (e.requester)
        pendingByGuest[e.requester.guestId] = (pendingByGuest[e.requester.guestId] ?? 0) + 1;
      const ip = this.#ips.get(e.id);
      if (ip !== undefined) pendingByIp[ip] = (pendingByIp[ip] ?? 0) + 1;
    }
    const live = [
      ...(this.#state.nowPlaying ? [this.#state.nowPlaying] : []),
      ...this.#state.queue,
    ];
    for (const e of [...this.#state.history, ...live]) {
      if (e.source !== 'request') continue;
      if (e.requester) {
        lastByGuest[e.requester.guestId] = Math.max(
          lastByGuest[e.requester.guestId] ?? 0,
          e.enqueuedAt,
        );
      }
      const ip = this.#ips.get(e.id);
      if (ip !== undefined) lastByIp[ip] = Math.max(lastByIp[ip] ?? 0, e.enqueuedAt);
    }
    const limits = this.#d.settings.data().limits;
    return checkRequest(limits, {
      guestId: input.guestId,
      ip: input.ip,
      videoId: input.videoId,
      ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
      now: this.#d.now(),
      pendingByGuest,
      lastRequestAtByGuest: lastByGuest,
      queuedVideoIds: live.map((e) => e.videoId),
      pendingByIp,
      lastRequestAtByIp: lastByIp,
    });
  }

  /** Enqueues a request (idempotent on `idempotencyKey`). Limits are the caller's job. */
  enqueue(input: RequestInput): { entry: Entry | HistoryEntry; duplicate: boolean } {
    const isOwner = input.guestId === null;
    const requester = isOwner
      ? { guestId: OWNER_GUEST_ID, name: OWNER_NAME }
      : {
          guestId: input.guestId as string,
          ...(input.name !== null ? { name: input.name } : {}),
        };
    const r = enqueueRequest(this.#state, {
      // Never derived from the client's idempotency key (guests must not see each other's keys).
      id: `req:${randomUUID()}`,
      videoId: input.videoId,
      title: input.title,
      requester,
      idempotencyKey: input.idempotencyKey,
      now: this.#d.now(),
      ...(input.channelTitle !== undefined ? { channelTitle: input.channelTitle } : {}),
      ...(input.thumbnail !== undefined ? { thumbnail: input.thumbnail } : {}),
      ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
    });
    if (r.duplicate) return { entry: r.entry, duplicate: true };
    if (!isOwner) this.#ips.set(r.entry.id, input.ip);
    // A request after an automatic stop means someone wants music again.
    this.#meta.stopped = false;
    this.#d.repos.events.append(
      'request',
      { entryId: r.entry.id, videoId: input.videoId, owner: isOwner },
      this.#d.now(),
    );
    this.#apply(r);
    this.#commit();
    return { entry: r.entry, duplicate: false };
  }

  // -------------------------------------------------------------------------------------------
  // Owner commands

  transport(action: 'play' | 'pause' | 'skip'): void {
    const now = this.#d.now();
    const np = this.#state.nowPlaying;
    this.#d.repos.events.append('admin.transport', { action, revision: this.revision }, now);
    if (action === 'pause') {
      if (np !== null && this.#meta.pausedAt === null) {
        this.#meta.pausedAt = now;
        this.#commit();
      }
      return;
    }
    if (action === 'play') {
      if (np !== null) {
        if (this.#meta.pausedAt !== null) {
          this.#meta.accumulatedPauseMs += now - this.#meta.pausedAt;
          this.#meta.pausedAt = null;
          this.#commit();
        }
        return;
      }
      this.#meta.stopped = false;
      this.#meta.consecutiveFailures = 0;
      this.#apply(restoreAfterRestart(this.#state, { now, positionSec: 0 }));
      this.#commit();
      return;
    }
    const r = ownerSkip(this.#state, now);
    if (r.committed) {
      this.#apply(r);
      this.#commit();
    }
  }

  reorder(id: string, toIndex: number): boolean {
    if (!this.#state.queue.some((e) => e.id === id)) return false;
    this.#apply(reorder(this.#state, id, toIndex));
    this.#d.repos.events.append('admin.reorder', { entryId: id, toIndex }, this.#d.now());
    this.#commit();
    return true;
  }

  remove(id: string): boolean {
    const known = this.#state.nowPlaying?.id === id || this.#state.queue.some((e) => e.id === id);
    if (!known) return false;
    this.#apply(remove(this.#state, id, this.#d.now()));
    this.#d.repos.events.append('admin.remove', { entryId: id }, this.#d.now());
    this.#commit();
    return true;
  }

  /** Forget me / delete guest data: drops the guest's attribution everywhere (history kept). */
  forgetGuest(guestId: string): void {
    this.#d.repos.history.anonymise(guestId);
    this.#d.repos.guests.forget(guestId, this.#d.now());
    this.#d.repos.events.append('guest.forget', {}, this.#d.now());
    this.stripGuest(guestId);
  }

  /** Drops the guest's attribution from this session's live state (the database is the caller's). */
  stripGuest(guestId: string): void {
    const strip = <T extends Entry | HistoryEntry>(e: T): T =>
      e.requester?.guestId === guestId ? { ...e, requester: null } : e;
    this.#state = {
      ...this.#state,
      nowPlaying: this.#state.nowPlaying ? strip(this.#state.nowPlaying) : null,
      queue: this.#state.queue.map(strip),
      history: this.#state.history.map(strip),
    };
    this.#commit();
  }

  /** Re-broadcast after a settings change (room name, limits, Wi-Fi, key). */
  touch(): void {
    // Idle with a player online (e.g. a playlist was just added): start the fallback.
    if (this.#state.nowPlaying === null) this.#fallback();
    this.#commit();
  }

  // -------------------------------------------------------------------------------------------
  // Players

  #ensurePlayer(id: string, name: string, order = 0): LivePlayer {
    let p = this.#players.get(id);
    if (!p) {
      p = {
        id,
        name,
        order,
        lanAddress: null,
        status: 'offline',
        lastSeen: 0,
        drift: null,
        overCount: 0,
        sockets: 0,
        disconnectedAt: null,
        lastError: null,
        autoplayBlocked: false,
      };
      this.#players.set(id, p);
    }
    return p;
  }

  playerConnected(id: string, name: string, lanAddress: string | null): void {
    const now = this.#d.now();
    const p = this.#ensurePlayer(id, name);
    p.sockets += 1;
    p.lanAddress = lanAddress;
    p.lastSeen = now;
    p.disconnectedAt = null;
    if (p.status !== 'blocked') p.status = 'online';
    this.#playerSeenSinceBoot = true;
    const np = this.#state.nowPlaying;
    if (np !== null && this.#unheard) {
      // Nobody heard this track yet in this run: start its clock now (at the resume point)
      // instead of mid-song. Once per track; reconnects and `playing` reports never move it.
      const paused = this.#clock(np).pausedAt !== null;
      this.#state = {
        ...this.#state,
        nowPlaying: { ...np, startedAt: now - Math.round(this.#resumeFromSec * 1000) },
      };
      this.#meta.pausedAt = paused ? now : null;
      this.#meta.accumulatedPauseMs = 0;
      this.#meta.clockRevision = this.#state.revision;
      this.#unheard = false;
      this.#resumeFromSec = 0;
    }
    if (this.#pendingFallback || this.#state.nowPlaying === null) this.#fallback();
    this.#commit();
  }

  playerDisconnected(id: string): void {
    const p = this.#players.get(id);
    if (!p) return;
    p.sockets = Math.max(0, p.sockets - 1);
    if (p.sockets > 0) return;
    p.disconnectedAt = this.#d.now();
    p.status = 'reconnecting';
    this.#commit();
  }

  /** Liveness from any player message. */
  playerSeen(id: string): void {
    const p = this.#players.get(id);
    if (!p) return;
    p.lastSeen = this.#d.now();
    if (p.status === 'reconnecting' && p.sockets > 0) {
      p.status = 'online';
      this.#commit();
    }
  }

  position(id: string, position: number, playerState: number, revision: number): void {
    const p = this.#players.get(id);
    if (!p) return;
    const now = this.#d.now();
    p.lastSeen = now;
    const before = p.status;
    const np = this.#state.nowPlaying;
    const current = np !== null && revision === this.#state.revision;
    if (current) {
      this.#meta.lastPositionSec = position;
      this.#meta.positionRevision = revision;
      this.#unheard = false;
      if (now - this.#lastPositionSave >= POSITION_SAVE_MS) {
        this.#lastPositionSave = now;
        this.#persist();
      }
    }
    p.drift =
      current && DRIFT_STATES.has(playerState)
        ? position - expectedPosition(this.#clock(np), now)
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
    if (p.status !== before) this.#commit();
  }

  /**
   * A player event. `ended`/`error` go through the core single-transition rule with the
   * player's revision (duplicates and late reports never advance twice).
   */
  event(
    id: string,
    kind: 'ended' | 'error' | 'autoplayBlocked' | 'playing' | 'stalled',
    revision: number,
    code?: number,
  ): { committed: boolean } {
    const p = this.#players.get(id);
    if (!p) return { committed: false };
    const now = this.#d.now();
    p.lastSeen = now;
    if (kind === 'ended' || kind === 'error') {
      const np = this.#state.nowPlaying;
      const message = playerErrorMessage(code);
      if (kind === 'error') {
        p.lastError = { ...(code !== undefined ? { code: String(code) } : {}), message, at: now };
      }
      // Only the group's leader moves the queue (followers report too; they are ignored).
      if (this.#leader() !== p) {
        if (kind === 'error') this.#commit();
        return { committed: false };
      }
      const r = transition(this.#state, {
        kind,
        revision,
        now,
        ...(kind === 'error' ? { failReason: message } : {}),
      });
      if (!r.committed) {
        if (kind === 'error') this.#commit();
        return { committed: false };
      }
      this.#d.repos.events.append(
        'transition',
        {
          kind,
          revision,
          entryId: np?.id ?? null,
          videoId: np?.videoId ?? null,
          code: code ?? null,
        },
        now,
      );
      if (kind === 'error') {
        this.#meta.consecutiveFailures += 1;
        this.#meta.lastErrors = [
          ...this.#meta.lastErrors,
          {
            at: now,
            videoId: np?.videoId ?? '',
            ...(code !== undefined ? { code: String(code) } : {}),
            message,
          },
        ].slice(-LAST_ERRORS);
      } else {
        this.#meta.consecutiveFailures = 0;
      }
      const wasStopped = this.#meta.stopped;
      this.#apply(r);
      this.#commit();
      if (kind === 'error') {
        const failure: PlayFailure = {
          entry: np,
          reason: message,
          stopped: !wasStopped && this.#meta.stopped,
        };
        for (const l of this.#failListeners) {
          try {
            l(failure);
          } catch (err) {
            this.#d.onError?.(err);
          }
        }
      }
      return { committed: true };
    }
    if (kind === 'autoplayBlocked') {
      p.status = 'blocked';
      p.autoplayBlocked = true;
    } else if (kind === 'playing') {
      if (revision === this.#state.revision && this.#state.nowPlaying !== null) {
        this.#meta.consecutiveFailures = 0;
        this.#meta.stopped = false;
        this.#unheard = false;
      }
      p.autoplayBlocked = false;
      p.lastError = null;
      if (p.status === 'blocked' || p.status === 'reconnecting') p.status = 'online';
    } else if (kind === 'stalled') {
      p.status = 'delayed';
    }
    this.#commit();
    return { committed: false };
  }

  /** Reconnecting after 10 s of silence, Offline 60 s after the last socket closed. */
  sweep(): boolean {
    const now = this.#d.now();
    let changed = false;
    for (const p of this.#players.values()) {
      if (
        p.sockets > 0 &&
        p.status !== 'reconnecting' &&
        now - p.lastSeen > RECONNECTING_AFTER_MS
      ) {
        p.status = 'reconnecting';
        changed = true;
      } else if (
        p.sockets === 0 &&
        p.status !== 'offline' &&
        p.disconnectedAt !== null &&
        now - p.disconnectedAt > OFFLINE_AFTER_MS
      ) {
        p.status = 'offline';
        changed = true;
      }
    }
    // Leader failover (5 s without a heartbeat) changes every player's `me.role`.
    if (!changed && (this.#leader()?.id ?? null) !== this.#lastLeader) changed = true;
    if (changed) this.#commit();
    return changed;
  }

  // -------------------------------------------------------------------------------------------
  // Projections

  #clock(np: Entry): { startedAt: number; pausedAt: number | null; accumulatedPauseMs: number } {
    const sameRevision = this.#meta.clockRevision === this.#state.revision;
    return {
      startedAt: np.startedAt ?? this.#d.now(),
      pausedAt: sameRevision ? this.#meta.pausedAt : null,
      accumulatedPauseMs: sameRevision ? this.#meta.accumulatedPauseMs : 0,
    };
  }

  /**
   * The oldest healthy player (connected and heard from within `LEADER_FAILOVER_MS`); else the
   * oldest connected one; else the oldest known one.
   */
  #leader(): LivePlayer | undefined {
    const now = this.#d.now();
    const all = [...this.#players.values()].sort((a, b) => a.order - b.order);
    const connected = all.filter((p) => p.sockets > 0);
    return connected.find((p) => now - p.lastSeen <= LEADER_FAILOVER_MS) ?? connected[0] ?? all[0];
  }

  /** The current leader's device ID (null without players). */
  leaderId(): string | null {
    return this.#leader()?.id ?? null;
  }

  #playback(viewer?: string | null): Playback {
    const np = this.#state.nowPlaying;
    if (np === null) return { state: 'idle', nowPlaying: null };
    const clock = this.#clock(np);
    const nowPlaying: NowPlaying = {
      ...toEntryPublic(np, viewer),
      startedAt: clock.startedAt,
      pausedAt: clock.pausedAt,
      accumulatedPauseMs: clock.accumulatedPauseMs,
    };
    const leader = this.#leader();
    const state =
      leader?.status === 'blocked' ? 'blocked' : clock.pausedAt !== null ? 'paused' : 'playing';
    return { state, nowPlaying };
  }

  #recentHistory(): (Entry | HistoryEntry)[] {
    return this.#state.history.slice(-RECENT_HISTORY).reverse();
  }

  #base() {
    return {
      revision: this.#state.revision,
      changeSeq: this.#changeSeq,
      serverTime: this.#d.now(),
      protocolVersion: M2_PROTOCOL_VERSION,
      roomName: this.#d.roomName?.() ?? this.#d.settings.data().roomName,
    };
  }

  /** Guest projection: no guest IDs, keys, IPs or tokens; `mine` for `guestId`. */
  toGuestState(guestId: string | null): GuestState {
    const settings = this.#d.settings.data();
    return {
      ...this.#base(),
      playback: this.#playback(guestId),
      queue: this.#state.queue.map((e) => toEntryPublic(e, guestId)),
      recentHistory: this.#recentHistory().map((e) => toEntryPublic(e, guestId)),
      search: this.#d.youtube.searchState(guestId),
      limits: {
        maxPendingPerGuest: settings.limits.maxPendingPerGuest,
        cooldownSec: settings.limits.cooldownSec,
        maxDurationSec: settings.limits.maxDurationSec,
        allowDuplicates: settings.limits.allowDuplicates,
      },
      flags: {
        hasApiKey: this.#d.youtube.hasKey(),
        publicMode: settings.publicMode,
        mirror: settings.search?.mirror ?? true,
      },
    };
  }

  players(): PlayerInfo[] {
    const leader = this.#leader();
    return [...this.#players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      lanAddress: p.lanAddress,
      status: p.status,
      role: p === leader ? 'leader' : 'follower',
      lastSeen: p.lastSeen,
      drift: p.drift,
    }));
  }

  /** Size of the fallback pool (playable playlist videos ∪ finished requests). */
  poolSize(): number {
    const ids = new Set(this.#playlistVideos().map((v) => v.videoId));
    for (const h of this.#state.history) {
      if (h.source === 'request' && h.status === 'done') ids.add(h.videoId);
    }
    return ids.size;
  }

  toAdminState(): AdminState {
    const guest = this.toGuestState(null);
    const settingsPublic = this.#d.settings.toPublic();
    const searches = this.#d.youtube.searchesReply();
    return {
      ...guest,
      playback: this.#playback(),
      queue: this.#state.queue.map(toEntryAdmin),
      recentHistory: this.#recentHistory().map(toEntryAdmin),
      players: this.players(),
      fallback: {
        playlists: settingsPublic.fallbackPlaylists,
        poolSize: this.poolSize(),
        consecutiveFailures: this.#meta.consecutiveFailures,
      },
      searchUsage: { guests: searches.guests, owner: searches.owner, resetsAt: searches.resetsAt },
      settings: settingsPublic,
      lastErrors: this.#meta.lastErrors.slice(-LAST_ERRORS),
    };
  }

  toPlayerState(playerId: string): PlayerState {
    const settings = this.#d.settings.data();
    const p = this.#players.get(playerId);
    const lan = lanReply(this.#d.lan, settings, this.#d.friendly);
    // Non-main groups print `<join>/r/<groupId>` so guests act on this group.
    const suffix = this.#groupId === MAIN_GROUP_ID ? '' : `r/${encodeURIComponent(this.#groupId)}`;
    const leader = this.#leader();
    const lastError = this.#meta.stopped
      ? { code: 'stopped', message: STOPPED_MESSAGE, at: this.#d.now() }
      : (p?.lastError ?? null);
    return {
      ...this.#base(),
      playback: this.#playback(),
      upcoming: this.#state.queue.slice(0, 5).map((e) => ({
        title: e.title,
        requesterName: e.requester?.name ?? null,
      })),
      qr: {
        lanUrl: `${lan.lanUrl}${suffix}`,
        joinUrl: `${joinUrl(lan, settings.lanPort)}${suffix}`,
        publicUrl: null,
        wifi: wifiQrPayload(settings.wifi, this.#d.settings.wifiPassword()),
        wifiSsid: settings.wifi?.ssid ? settings.wifi.ssid : null,
      },
      partyCode: null,
      me: { playerId, role: p === undefined || p === leader ? 'leader' : 'follower' },
      status: p?.status ?? 'offline',
      lastError,
      selfTest: { autoplayBlocked: p?.autoplayBlocked ?? false },
    };
  }

  /** Stops persisting (the database is closing). */
  close(): void {
    this.#closed = true;
  }

  /** Makes a player device known (status Offline until it connects). `order`: leader order. */
  addPlayer(id: string, name: string, order = 0): void {
    this.#ensurePlayer(id, name, order).name = name;
  }

  hasPlayer(id: string): boolean {
    return this.#players.has(id);
  }

  /** Removes a player (moved to another group, or revoked) and returns its live status. */
  detachPlayer(id: string): LivePlayer | null {
    const p = this.#players.get(id);
    if (!p) return null;
    this.#players.delete(id);
    this.#commit();
    return p;
  }

  /** Adopts a player detached from another group (keeps its sockets and status). */
  attachPlayer(p: LivePlayer): void {
    this.#players.set(p.id, p);
    if (p.sockets > 0) {
      this.#playerSeenSinceBoot = true;
      if (this.#pendingFallback || this.#state.nowPlaying === null) this.#fallback();
    }
    this.#commit();
  }

  /** The live entries (now playing first, then the queue). */
  liveEntries(): Entry[] {
    return [...(this.#state.nowPlaying ? [this.#state.nowPlaying] : []), ...this.#state.queue];
  }

  /** True when the last persist failed (surfaced in logs and healthz-style checks). */
  get persistFailed(): boolean {
    return this.#persistError;
  }
}
