/**
 * Queue machine (plan §3.4): FIFO requests, auto (fallback) entries, owner reorder/remove/skip,
 * the single-transition rule and the restart rule.
 *
 * Every operation is a pure function `(state, input) → { state, effects }`. Nothing here reads a
 * clock, schedules a timer or draws a random number: callers pass `now` in and act on the returned
 * effects (tell the players to play, ask the fallback picker for a track).
 *
 * `revision` identifies one play instance of `nowPlaying`: it is bumped exactly once every time
 * `nowPlaying` changes (a committed transition, starting from idle, a restart) and never by queue
 * edits that leave `nowPlaying` alone. A player's `ended`/`error` report carries the revision it
 * saw, so duplicate and late reports can never advance twice.
 */

export type EntryStatus = 'queued' | 'playing' | 'done' | 'skipped' | 'failed';
export type EntrySource = 'request' | 'auto';

export interface Requester {
  guestId: string;
  name?: string;
}

export interface Entry {
  id: string;
  videoId: string;
  title: string;
  /** YouTube channel title; used as the artist by the fallback picker when present. */
  channelTitle?: string;
  thumbnail?: string;
  durationSec?: number;
  /** `null` for auto entries (fallback picks) and owner adds without a guest. */
  requester: Requester | null;
  source: EntrySource;
  status: EntryStatus;
  failReason?: string;
  /** The guest command's `clientId + nonce`; repeating it returns the existing entry. */
  idempotencyKey?: string;
  /** ms */
  enqueuedAt: number;
  /** ms, set when the entry starts (again, after a restart). */
  startedAt?: number;
  /** Set when the restart rule restarted this entry; it is never restarted twice. */
  restarted?: boolean;
}

/** Why an entry left the queue without finishing. */
export type SkipReason = 'owner' | 'player' | 'removed' | 'restart';

export interface HistoryEntry extends Omit<Entry, 'status'> {
  status: 'done' | 'skipped' | 'failed';
  /** ms */
  endedAt: number;
  skipReason?: SkipReason;
}

export interface QueueState {
  revision: number;
  nowPlaying: Entry | null;
  /** Upcoming entries, in play order. All have status `queued`. */
  queue: Entry[];
  /** Finished entries, oldest first. */
  history: HistoryEntry[];
}

export type Effect =
  /** Tell the group's players to play `entry` from the start (also used for a restart). */
  | { type: 'play'; entry: Entry; revision: number }
  /** Nothing is queued: ask the fallback picker for an auto entry and `enqueueAuto` it. */
  | { type: 'needFallback' };

export interface MachineResult {
  state: QueueState;
  effects: Effect[];
}

export interface TransitionOutcome extends MachineResult {
  /** False when the report was stale, duplicated or arrived while idle; `state` is unchanged. */
  committed: boolean;
}

export interface EnqueueOutcome extends MachineResult {
  /** The new entry, or the existing one for a repeated idempotency key. */
  entry: Entry | HistoryEntry;
  /** True when the idempotency key was already used; `state` is unchanged. */
  duplicate: boolean;
}

export const emptyQueueState = (): QueueState => ({
  revision: 0,
  nowPlaying: null,
  queue: [],
  history: [],
});

function start(state: QueueState, entry: Entry, now: number): MachineResult {
  const playing: Entry = { ...entry, status: 'playing', startedAt: now };
  const revision = state.revision + 1;
  return {
    state: { ...state, revision, nowPlaying: playing },
    effects: [{ type: 'play', entry: playing, revision }],
  };
}

/** Starts the head of the queue, or goes idle and asks for a fallback. Bumps the revision once. */
function advance(state: QueueState, now: number): MachineResult {
  const [next, ...rest] = state.queue;
  if (next === undefined) {
    return {
      state: { ...state, revision: state.revision + 1, nowPlaying: null },
      effects: [{ type: 'needFallback' }],
    };
  }
  return start({ ...state, queue: rest }, next, now);
}

function toHistory(
  entry: Entry,
  status: HistoryEntry['status'],
  now: number,
  extra: { failReason?: string; skipReason?: SkipReason } = {},
): HistoryEntry {
  const h: HistoryEntry = { ...entry, status, endedAt: now };
  if (extra.failReason !== undefined) h.failReason = extra.failReason;
  if (extra.skipReason !== undefined) h.skipReason = extra.skipReason;
  return h;
}

/** Finds an entry carrying `key` in now playing, the queue or the history. */
export function findByIdempotencyKey(
  state: QueueState,
  key: string,
): Entry | HistoryEntry | undefined {
  if (state.nowPlaying?.idempotencyKey === key) return state.nowPlaying;
  return (
    state.queue.find((e) => e.idempotencyKey === key) ??
    state.history.find((e) => e.idempotencyKey === key)
  );
}

export interface EnqueueRequestInput {
  videoId: string;
  title: string;
  requester: Requester | null;
  idempotencyKey: string;
  now: number;
  /** Defaults to `req:<idempotencyKey>`, which is unique because the key is. */
  id?: string;
  channelTitle?: string;
  thumbnail?: string;
  durationSec?: number;
}

/**
 * Adds a guest (or owner) request after the current track and every earlier request, i.e. before
 * any queued auto entries. Starts it immediately when nothing is playing. A repeated
 * `idempotencyKey` returns the existing entry and changes nothing.
 */
export function enqueueRequest(state: QueueState, input: EnqueueRequestInput): EnqueueOutcome {
  const existing = findByIdempotencyKey(state, input.idempotencyKey);
  if (existing !== undefined) return { state, effects: [], entry: existing, duplicate: true };

  const entry: Entry = {
    id: input.id ?? `req:${input.idempotencyKey}`,
    videoId: input.videoId,
    title: input.title,
    requester: input.requester,
    source: 'request',
    status: 'queued',
    idempotencyKey: input.idempotencyKey,
    enqueuedAt: input.now,
  };
  if (input.channelTitle !== undefined) entry.channelTitle = input.channelTitle;
  if (input.thumbnail !== undefined) entry.thumbnail = input.thumbnail;
  if (input.durationSec !== undefined) entry.durationSec = input.durationSec;

  if (state.nowPlaying === null && state.queue.length === 0) {
    const r = start(state, entry, input.now);
    return { ...r, entry: r.state.nowPlaying as Entry, duplicate: false };
  }

  let lastRequest = -1;
  state.queue.forEach((e, i) => {
    if (e.source === 'request') lastRequest = i;
  });
  const queue = [...state.queue];
  queue.splice(lastRequest + 1, 0, entry);
  const next: QueueState = { ...state, queue };
  // Idle with a non-empty queue (e.g. after the owner stopped): start the head.
  if (next.nowPlaying === null) {
    const r = advance(next, input.now);
    return { ...r, entry, duplicate: false };
  }
  return { state: next, effects: [], entry, duplicate: false };
}

/**
 * Appends an auto (fallback) entry at the end of the queue; starts it when nothing is playing.
 * The caller supplies the id. Ignored (no change) when an entry with the same id already exists.
 */
export function enqueueAuto(
  state: QueueState,
  entry: Omit<Entry, 'source' | 'status' | 'requester'> & { requester?: null },
): MachineResult {
  if (state.nowPlaying?.id === entry.id || state.queue.some((e) => e.id === entry.id)) {
    return { state, effects: [] };
  }
  const auto: Entry = { ...entry, requester: null, source: 'auto', status: 'queued' };
  const next: QueueState = { ...state, queue: [...state.queue, auto] };
  return next.nowPlaying === null ? advance(next, auto.enqueuedAt) : { state: next, effects: [] };
}

/** Owner reorder: moves the queued entry `id` to `toIndex` (clamped). Revision unchanged. */
export function reorder(state: QueueState, id: string, toIndex: number): MachineResult {
  const from = state.queue.findIndex((e) => e.id === id);
  if (from === -1) return { state, effects: [] };
  const queue = [...state.queue];
  const [moved] = queue.splice(from, 1);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), queue.length));
  queue.splice(to, 0, moved as Entry);
  return { state: { ...state, queue }, effects: [] };
}

/**
 * Owner remove. A queued entry goes to history as `skipped` (reason `removed`) and the revision is
 * unchanged; removing the now-playing entry is an owner skip.
 */
export function remove(state: QueueState, id: string, now: number): MachineResult {
  if (state.nowPlaying?.id === id) return ownerSkip(state, now);
  const index = state.queue.findIndex((e) => e.id === id);
  if (index === -1) return { state, effects: [] };
  const entry = state.queue[index] as Entry;
  return {
    state: {
      ...state,
      queue: state.queue.filter((_, i) => i !== index),
      history: [...state.history, toHistory(entry, 'skipped', now, { skipReason: 'removed' })],
    },
    effects: [],
  };
}

/** Owner skip: always commits against the current revision (the owner is authoritative). */
export function ownerSkip(state: QueueState, now: number): TransitionOutcome {
  return commit(state, 'skipped', now, { skipReason: 'owner' });
}

export interface TransitionEvent {
  kind: 'ended' | 'error' | 'skipped';
  /** The revision the reporting player saw. */
  revision: number;
  failReason?: string;
  now: number;
}

function commit(
  state: QueueState,
  status: HistoryEntry['status'],
  now: number,
  extra: { failReason?: string; skipReason?: SkipReason } = {},
): TransitionOutcome {
  const current = state.nowPlaying;
  if (current === null) return { state, effects: [], committed: false };
  const r = advance(
    {
      ...state,
      nowPlaying: null,
      history: [...state.history, toHistory(current, status, now, extra)],
    },
    now,
  );
  return { ...r, committed: true };
}

/**
 * Single-transition rule: commits only when `event.revision` equals the current revision and
 * something is playing; then moves now playing to history (`ended` → done, `error` → failed with
 * `failReason`, `skipped` → skipped by the player), starts the next queued entry or emits
 * `needFallback`, and bumps the revision exactly once. Otherwise returns the same state object.
 */
export function transition(state: QueueState, event: TransitionEvent): TransitionOutcome {
  if (event.revision !== state.revision) return { state, effects: [], committed: false };
  switch (event.kind) {
    case 'ended':
      return commit(state, 'done', event.now);
    case 'error':
      return commit(state, 'failed', event.now, { failReason: event.failReason ?? 'error' });
    case 'skipped':
      return commit(state, 'skipped', event.now, { skipReason: 'player' });
  }
}

/** Seconds before the end inside which an interrupted track counts as finished. */
export const RESTART_TAIL_SEC = 30;

export interface RestoreInput {
  now: number;
  /** Last known position of now playing, in seconds. */
  positionSec: number;
  /** Track duration in seconds; falls back to `nowPlaying.durationSec`. */
  durationSec?: number;
}

/**
 * Restart rule, applied by the server at start-up when no live player holds the track: if
 * `position < duration − 30 s` and the entry was not restarted before, play it again from the
 * start once (`restarted = true`); otherwise advance (`done` when it was within 30 s of the end,
 * `skipped` with reason `restart` when it had already been restarted). With an unknown duration
 * the track is restarted (once). With nothing playing, starts the queue head or asks for a
 * fallback. Always bumps the revision so reports from before the restart are stale.
 */
export function restoreAfterRestart(state: QueueState, input: RestoreInput): MachineResult {
  const current = state.nowPlaying;
  if (current === null) return advance(state, input.now);
  const duration = input.durationSec ?? current.durationSec;
  const nearEnd = duration !== undefined && input.positionSec >= duration - RESTART_TAIL_SEC;
  if (nearEnd) return commit(state, 'done', input.now);
  if (current.restarted === true)
    return commit(state, 'skipped', input.now, { skipReason: 'restart' });
  return start(state, { ...current, restarted: true }, input.now);
}
